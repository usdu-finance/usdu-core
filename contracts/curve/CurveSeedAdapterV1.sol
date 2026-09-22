// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Context} from '@openzeppelin/contracts/utils/Context.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IStablecoinMetadata} from '../stablecoin/IStablecoinMetadata.sol';

import {ITwocrypto} from './helpers/ITwocrypto.sol';

/**
 * @title CurveSeedAdapterV1
 * @author @samclassix <samclassix@proton.me>
 * @notice Curator-only seeding utility for any Curve TwoCrypto-NG pool pairing USDU (always coin(0))
 *         with another protocol stablecoin (e.g. EURU or CHFU, coin(1)). A single instance manages
 *         every such pool, keyed by pool address, so it doubles as the module registered on USDU and
 *         on every paired stablecoin.
 * @dev Per pool: seed() mints USDU plus a surplus-padded amount of the other leg (sized off the
 *      pool's live price_scale()), deposits a balanced pair, burns whatever of the surplus wasn't
 *      needed, and tracks both legs' minted debt. removeLiquidity() unwinds LP tokens back into this
 *      contract and immediately settles `pool`'s debt from the withdrawal in the same call (via
 *      _repay), draining this contract's usdu/other balance back to zero before any other pool's
 *      operation can run — that's what keeps a shared token balance from ever being attributable to
 *      the wrong pool. repayDebt() is the same settlement, exposed standalone for any balance that
 *      lands here outside of removeLiquidity (e.g. a direct top-up). No ongoing revenue/reconcile
 *      machinery beyond that — this is a seeding + unwind tool, not an adapter that stays deployed
 *      against trading fees.
 */
contract CurveSeedAdapterV1 is Context {
	using SafeERC20 for IStablecoinMetadata;

	/// @notice Outstanding minted debt for a pool, denominated in each leg's own token.
	struct Debt {
		uint256 usdu;
		uint256 other;
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Thrown when `amountUsdu` is zero.
	error ZeroAmount();

	/// @notice Thrown when `pool`'s coin(0) is not USDU.
	error InvalidPool(ITwocrypto pool);

	// ---------------------------------------------------------------------------------------

	/// @notice Emitted after a seeding deposit into `pool`.
	event Seed(ITwocrypto indexed pool, uint256 amountUsdu, uint256 amountOther, uint256 shares);

	/// @notice Emitted after the curator unwinds (part of) `pool`'s LP position into this contract.
	event RemoveLiquidity(ITwocrypto indexed pool, uint256 shares, uint256[2] withdrawn);

	/// @notice Emitted whenever `pool`'s debt is repaid, whether via removeLiquidity or repayDebt.
	event RepayDebt(ITwocrypto indexed pool, uint256 repaidUsdu, uint256 repaidOther);

	// ---------------------------------------------------------------------------------------

	/// @notice USDU, present as coin(0) in every pool this adapter seeds.
	IStablecoinMetadata public immutable usdu;

	/// @notice Outstanding minted debt per pool.
	mapping(ITwocrypto => Debt) public debts;

	// ---------------------------------------------------------------------------------------

	modifier onlyCurator() {
		usdu.verifyCurator(_msgSender());
		_;
	}

	// ---------------------------------------------------------------------------------------

	constructor(IStablecoinMetadata _usdu) {
		usdu = _usdu;
	}

	// ---------------------------------------------------------------------------------------

	/// @dev Reverts unless `pool`'s coin(0) is USDU, and returns coin(1) (the other leg).
	function _verifyPool(ITwocrypto pool) internal view returns (IStablecoinMetadata other) {
		if (pool.coins(0) != address(usdu)) revert InvalidPool(pool);
		other = IStablecoinMetadata(pool.coins(1));
	}

	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Mints `amountUsdu` USDU plus a `surplusBps`-padded amount of `pool`'s other leg (sized
	 *         off the pool's current price_scale), deposits a balanced pair at that same price_scale,
	 *         burns whatever of the padded surplus wasn't used, and adds both legs to `pool`'s debt.
	 * @param pool The TwoCrypto-NG pool to seed, with USDU as coin(0).
	 * @param amountUsdu Amount of USDU to mint and seed with.
	 * @param surplusBps Extra padding, in bps of the FX-implied other-leg amount, minted upfront as a
	 *        buffer against price_scale drift between tx submission and execution.
	 * @param minShares Minimum LP tokens accepted (slippage protection).
	 * @return shares LP tokens received, held by this adapter.
	 */
	function seed(
		ITwocrypto pool,
		uint256 amountUsdu,
		uint256 surplusBps,
		uint256 minShares
	) external onlyCurator returns (uint256 shares) {
		if (amountUsdu == 0) revert ZeroAmount();
		IStablecoinMetadata other = _verifyPool(pool);

		// FX-implied balanced amount of the other leg at the pool's current price_scale (price of
		// coin(1) denominated in coin(0) == USDU).
		uint256 amountOther = (amountUsdu * 1 ether) / pool.price_scale();
		uint256 amountOtherMinted = amountOther + (amountOther * surplusBps) / 10_000;

		usdu.mintModule(address(this), amountUsdu);
		other.mintModule(address(this), amountOtherMinted);

		usdu.forceApprove(address(pool), amountUsdu);
		other.forceApprove(address(pool), amountOther);

		uint256[2] memory amounts = [amountUsdu, amountOther];
		shares = pool.add_liquidity(amounts, minShares);

		// Burn whatever of the padded surplus wasn't needed for the balanced deposit.
		uint256 leftover = other.balanceOf(address(this));
		if (leftover != 0) other.burn(leftover);

		Debt storage debt = debts[pool];
		debt.usdu += amountUsdu;
		debt.other += amountOther;

		emit Seed(pool, amountUsdu, amountOther, shares);
	}

	/**
	 * @notice Curator-only unwind of (part of) `pool`'s LP position, immediately settling `pool`'s
	 *         debt from the proceeds in the same call (see repayDebt/_repay).
	 * @dev Repaying here rather than leaving it for a later, separate call is what keeps this
	 *      contract's usdu/other balance from ever sitting around between transactions where a
	 *      different pool's operation could pick it up — see _repay.
	 * @param pool The pool to withdraw from.
	 * @param shares LP tokens to redeem.
	 * @param minAmounts Minimum amounts expected for [coin(0), coin(1)] (slippage protection).
	 * @return withdrawn Amounts received [coin(0)Amount, coin(1)Amount].
	 */
	function removeLiquidity(
		ITwocrypto pool,
		uint256 shares,
		uint256[2] calldata minAmounts
	) external onlyCurator returns (uint256[2] memory withdrawn) {
		IStablecoinMetadata other = _verifyPool(pool);
		withdrawn = pool.remove_liquidity(shares, minAmounts, address(this));
		emit RemoveLiquidity(pool, shares, withdrawn);

		_settle(pool, other);
	}

	/**
	 * @notice Curator-only: burns down `pool`'s outstanding debt from this contract's current
	 *         usdu/other-leg balance, forwarding any balance beyond the debt to the curator. Exists
	 *         standalone (on top of removeLiquidity's own settlement) for balance that lands here
	 *         outside of a withdrawal, e.g. a direct top-up.
	 * @param pool The pool whose debt to repay.
	 * @return repaidUsdu Amount of USDU debt repaid.
	 * @return repaidOther Amount of other-leg debt repaid.
	 */
	function repayDebt(ITwocrypto pool) external onlyCurator returns (uint256 repaidUsdu, uint256 repaidOther) {
		IStablecoinMetadata other = _verifyPool(pool);
		return _settle(pool, other);
	}

	/// @dev Runs both legs of debt settlement for `pool` against this contract's current balance and
	///      emits RepayDebt. Curator-only via its two callers (removeLiquidity, repayDebt) — the
	///      balance spent here is shared across every pool this adapter manages, so an untrusted
	///      caller picking an arbitrary `pool` could otherwise sweep balance meant for a different
	///      pool's debt.
	function _settle(ITwocrypto pool, IStablecoinMetadata other) internal returns (uint256 repaidUsdu, uint256 repaidOther) {
		Debt storage debt = debts[pool];

		repaidUsdu = _repay(usdu, debt.usdu);
		debt.usdu -= repaidUsdu;

		repaidOther = _repay(other, debt.other);
		debt.other -= repaidOther;

		emit RepayDebt(pool, repaidUsdu, repaidOther);
	}

	/// @dev Burns up to `owed` of this contract's `token` balance, forwarding anything beyond that to
	///      the curator as surplus.
	function _repay(IStablecoinMetadata token, uint256 owed) internal returns (uint256 repaid) {
		uint256 balance = token.balanceOf(address(this));
		if (balance == 0) return 0;

		repaid = balance < owed ? balance : owed;
		if (repaid != 0) token.burn(repaid);

		uint256 surplus = balance - repaid;
		if (surplus != 0) token.transfer(usdu.curator(), surplus);
	}
}
