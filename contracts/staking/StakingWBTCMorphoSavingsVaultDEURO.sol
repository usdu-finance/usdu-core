// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ERC4626, ERC20, IERC20, IERC4626} from '@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import {IMorpho, MarketParams, Market, Position, Id} from '../morpho/helpers/IMorpho.sol';
import {MarketParamsLib} from '../morpho/helpers/MarketParamsLib.sol';
import {SharesMathLib} from '../morpho/helpers/SharesMathLib.sol';
import {IOracle} from '../morpho/helpers/IOracle.sol';

import {GPv2Order} from '../cow/helpers/GPv2Order.sol';
import {IGPv2Settlement} from '../cow/helpers/IGPv2Settlement.sol';

import {IStablecoinBridge} from './helpers/IStablecoinBridge.sol';
import {ISavingsVault} from './helpers/ISavingsVault.sol';
import {IStakingWBTCMorphoSavingsVaultDEURO} from './IStakingWBTCMorphoSavingsVaultDEURO.sol';

/**
 * @title StakingWBTCMorphoSavingsVaultDEURO
 * @author @samclassix <samclassix@proton.me>
 * @notice ERC-4626 vault, asset = WBTC. Deposits are supplied as collateral into a single Morpho Blue
 *         market (WBTC collateral / EURC loan). The vault then runs a leveraged carry trade against that
 *         collateral: it borrows EURC, bridges it 1:1 into dEURO (IStablecoinBridge), and deposits the
 *         dEURO into `savingsVault` (a SavingsVault holding svDEURO) to earn the dEURO savings rate.
 *         `_leverage`/`_deleverage` grow or shrink that borrow-and-invest position to track `targetLtv`
 *         (within `targetBand`) as WBTC/EUR price and Morpho's own borrow accrual move the position around.
 *
 *         The spread between the dEURO savings rate and the Morpho EURC borrow rate is the vault's yield.
 *         It is realized by `_reconcile`: redeemable savingsVault value above `savingsPrincipal` (the
 *         dEURO principal actually invested) is claimed, bridged back to EURC, and sold for WBTC through a
 *         CoW Swap intent (`_swap`, presigned on GPv2Settlement rather than executed atomically, since a
 *         solver may take time to fill it). Once filled, the WBTC proceeds are supplied as additional
 *         collateral, compounding the position.
 *
 * @dev `checkRebalance`/`rebalance` decide between four mutually exclusive actions — settling a filled or
 *      expired CoW order, reconciling claimable interest, leveraging, or deleveraging — and take at most
 *      one of them per call, so a keeper is expected to call `rebalance()` repeatedly until it reports
 *      Action.NONE. This keeps each on-chain step small and its effect easy to reason about, at the cost
 *      of needing multiple transactions (and, for the CoW leg, waiting for a solver) to fully settle.
 */
contract StakingWBTCMorphoSavingsVaultDEURO is ERC4626, Ownable, ReentrancyGuard, IStakingWBTCMorphoSavingsVaultDEURO {
	using Math for uint256;
	using SharesMathLib for uint256;
	using GPv2Order for GPv2Order.Data;

	uint256 internal constant WAD = 1e18;
	uint256 internal constant ORACLE_SCALE = 1e36;
	uint256 internal constant PPM = 1_000_000;

	/// @notice Safety margin kept between `targetLtv + targetBand` and the market's liquidation LTV, so
	///         rebalancing always has room to act before a position becomes liquidatable.
	uint256 public constant LTV_SAFETY_MARGIN = 0.02e18;

	uint256 public constant MAX_SLIPPAGE_PPM = 50_000; // 5%

	// ---------------------------------------------------------------------------------------

	IMorpho public immutable morpho;
	Id public immutable marketId;
	IOracle internal immutable oracle;
	address internal immutable irm;
	uint256 internal immutable lltv;

	IStablecoinBridge public immutable bridge;
	IERC20 internal immutable loanToken; // EURC
	IERC20 internal immutable deuro;
	ISavingsVault public immutable savingsVault;
	uint256 internal immutable eurcToDeuroScale; // 10 ** (deuro.decimals() - loanToken.decimals())

	IGPv2Settlement public immutable cowSettlement;
	address internal immutable cowVaultRelayer;

	uint256 public targetLtv;
	uint256 public targetBand;
	uint256 public swapSlippagePPM = 10_000; // 1%
	uint32 public orderValidity = 30 minutes;

	uint256 public savingsPrincipal;
	PendingOrder internal _pendingOrder;

	/// @notice Returns the CoW Swap intent this vault is currently waiting on a solver to fill, if any.
	function pendingOrder() external view returns (PendingOrder memory) {
		return _pendingOrder;
	}

	// ---------------------------------------------------------------------------------------

	constructor(
		address _owner,
		IERC20 _wbtc,
		IMorpho _morpho,
		MarketParams memory _market,
		IStablecoinBridge _bridge,
		ISavingsVault _savingsVault,
		IGPv2Settlement _cowSettlement,
		uint256 _targetLtv,
		uint256 _targetBand,
		string memory _name,
		string memory _symbol
	) ERC4626(_wbtc) ERC20(_name, _symbol) Ownable(_owner) {
		if (_market.collateralToken != address(_wbtc)) revert InvalidMarket();
		if (_market.loanToken != address(_bridge.eur())) revert InvalidMarket();
		if (address(_bridge.dEURO()) != _savingsVault.asset()) revert InvalidMarket();

		morpho = _morpho;
		marketId = MarketParamsLib.id(_market);
		oracle = IOracle(_market.oracle);
		irm = _market.irm;
		lltv = _market.lltv;

		bridge = _bridge;
		loanToken = IERC20(_market.loanToken);
		deuro = _bridge.dEURO();
		savingsVault = _savingsVault;
		eurcToDeuroScale = 10 ** (IERC20Metadata(address(deuro)).decimals() - IERC20Metadata(_market.loanToken).decimals());

		cowSettlement = _cowSettlement;
		cowVaultRelayer = _cowSettlement.vaultRelayer();

		_setTargetLtv(_targetLtv);
		_setTargetBand(_targetBand);

		SafeERC20.forceApprove(_wbtc, address(_morpho), type(uint256).max);
		SafeERC20.forceApprove(IERC20(_market.loanToken), address(_morpho), type(uint256).max);
		SafeERC20.forceApprove(IERC20(_market.loanToken), address(_bridge), type(uint256).max);
		SafeERC20.forceApprove(IERC20(address(deuro)), address(_bridge), type(uint256).max);
		SafeERC20.forceApprove(IERC20(address(deuro)), address(_savingsVault), type(uint256).max);
	}

	// ---------------------------------------------------------------------------------------
	// Owner configuration

	function setTargetLtv(uint256 newTargetLtv) external onlyOwner {
		_setTargetLtv(newTargetLtv);
	}

	function _setTargetLtv(uint256 newTargetLtv) internal {
		_checkLtvBounds(newTargetLtv, targetBand);
		emit TargetLtvChanged(targetLtv, newTargetLtv);
		targetLtv = newTargetLtv;
	}

	function setTargetBand(uint256 newTargetBand) external onlyOwner {
		_setTargetBand(newTargetBand);
	}

	function _setTargetBand(uint256 newTargetBand) internal {
		_checkLtvBounds(targetLtv, newTargetBand);
		emit TargetBandChanged(targetBand, newTargetBand);
		targetBand = newTargetBand;
	}

	function _checkLtvBounds(uint256 _targetLtv, uint256 _targetBand) internal view {
		if (_targetLtv + _targetBand + LTV_SAFETY_MARGIN > lltv) revert LtvOutOfBounds(_targetLtv, _targetBand, lltv);
	}

	function setSwapSlippagePPM(uint256 newSlippagePPM) external onlyOwner {
		if (newSlippagePPM > MAX_SLIPPAGE_PPM) revert SlippageTooHigh(newSlippagePPM, MAX_SLIPPAGE_PPM);
		emit SwapSlippageChanged(swapSlippagePPM, newSlippagePPM);
		swapSlippagePPM = newSlippagePPM;
	}

	function setOrderValidity(uint32 newValidity) external onlyOwner {
		emit OrderValidityChanged(orderValidity, newValidity);
		orderValidity = newValidity;
	}

	// ---------------------------------------------------------------------------------------
	// Views

	function _marketParams() internal view returns (MarketParams memory) {
		return MarketParams({loanToken: address(loanToken), collateralToken: asset(), oracle: address(oracle), irm: irm, lltv: lltv});
	}

	/// @dev Outstanding EURC debt, in loanToken units. Read from the last-accrued Morpho state; callers on
	///      the state-changing path call `morpho.accrueInterest` first so this is exact within that tx.
	function _debtAssets() internal view returns (uint256) {
		Position memory p = morpho.position(marketId, address(this));
		if (p.borrowShares == 0) return 0;
		Market memory m = morpho.market(marketId);
		return uint256(p.borrowShares).toAssetsUp(m.totalBorrowAssets, m.totalBorrowShares);
	}

	function _collateral() internal view returns (uint256) {
		return morpho.position(marketId, address(this)).collateral;
	}

	function _ltv() internal view returns (uint256) {
		uint256 collateral = _collateral();
		if (collateral == 0) return 0;
		uint256 debtInCollateral = _debtAssets().mulDiv(ORACLE_SCALE, oracle.price());
		return debtInCollateral.mulDiv(WAD, collateral);
	}

	function _toDeuro(uint256 eurcAmount) internal view returns (uint256) {
		return eurcAmount * eurcToDeuroScale;
	}

	function _toEurc(uint256 deuroAmount) internal view returns (uint256) {
		return deuroAmount / eurcToDeuroScale;
	}

	/// @notice Net asset value in WBTC: collateral + idle WBTC, plus the savings position and any idle
	///         EURC (both converted through the bridge's 1:1 peg and the Morpho oracle), minus outstanding
	///         debt. Value that is mid-flight in a pending CoW order still shows up here — either as the
	///         EURC that hasn't been pulled by the vault relayer yet, or as the WBTC it settles into.
	function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
		uint256 collateral = _collateral();
		uint256 idleWbtc = IERC20(asset()).balanceOf(address(this));
		uint256 debt = _debtAssets();

		uint256 savingsValue = _toEurc(savingsVault.previewRedeem(savingsVault.balanceOf(address(this))));
		uint256 idleEurc = loanToken.balanceOf(address(this)) + savingsValue;

		uint256 price = oracle.price();
		if (idleEurc >= debt) {
			return collateral + idleWbtc + (idleEurc - debt).mulDiv(ORACLE_SCALE, price);
		} else {
			uint256 shortfall = (debt - idleEurc).mulDiv(ORACLE_SCALE, price);
			uint256 gross = collateral + idleWbtc;
			return gross > shortfall ? gross - shortfall : 0;
		}
	}

	/// @notice The action `rebalance()` would take right now, without executing it.
	function checkRebalance() public view returns (Action) {
		if (_pendingOrder.orderUid.length > 0) {
			if (cowSettlement.filledAmount(_pendingOrder.orderUid) > 0 || block.timestamp > _pendingOrder.validTo) {
				return Action.SETTLE;
			}
			return Action.NONE;
		}

		if (savingsVault.previewRedeem(savingsVault.balanceOf(address(this))) > savingsPrincipal) {
			return Action.RECONCILE;
		}

		uint256 ltv = _ltv();
		if (ltv > targetLtv + targetBand) return Action.DELEVERAGE;
		if (targetLtv > targetBand && ltv < targetLtv - targetBand) return Action.LEVERAGE;
		return Action.NONE;
	}

	// ---------------------------------------------------------------------------------------
	// Rebalancing

	/// @notice Permissionlessly executes the single next rebalance action, if any. See
	///         {IStakingWBTCMorphoSavingsVaultDEURO-rebalance}.
	function rebalance() external nonReentrant returns (Action) {
		return _checkRebalance();
	}

	function _checkRebalance() internal returns (Action) {
		morpho.accrueInterest(_marketParams());

		if (_pendingOrder.orderUid.length > 0) {
			if (cowSettlement.filledAmount(_pendingOrder.orderUid) > 0 || block.timestamp > _pendingOrder.validTo) {
				_settlePendingOrder();
				emit Rebalanced(Action.SETTLE);
				return Action.SETTLE;
			}
			return Action.NONE;
		}

		if (savingsVault.previewRedeem(savingsVault.balanceOf(address(this))) > savingsPrincipal) {
			_reconcile();
			emit Rebalanced(Action.RECONCILE);
			return Action.RECONCILE;
		}

		uint256 ltv = _ltv();
		uint256 collateral = _collateral();
		uint256 debt = _debtAssets();
		uint256 targetDebt = collateral.mulDiv(oracle.price(), ORACLE_SCALE).mulDiv(targetLtv, WAD);

		if (ltv > targetLtv + targetBand && debt > targetDebt) {
			_deleverage(debt - targetDebt);
			emit Rebalanced(Action.DELEVERAGE);
			return Action.DELEVERAGE;
		} else if (targetLtv > targetBand && ltv < targetLtv - targetBand && targetDebt > debt) {
			_leverage(targetDebt - debt);
			emit Rebalanced(Action.LEVERAGE);
			return Action.LEVERAGE;
		}

		return Action.NONE;
	}

	/// @dev Borrows `amount` EURC against existing collateral, bridges it 1:1 into dEURO, and deposits the
	///      proceeds into `savingsVault`. Sweeps this contract's full dEURO balance rather than just the
	///      freshly-bridged amount, so any dust left over from a prior `_deleverage` gets reinvested too.
	function _leverage(uint256 amount) internal {
		morpho.borrow(_marketParams(), amount, 0, address(this), address(this));

		bridge.mint(amount);
		uint256 deuroAmount = IERC20(address(deuro)).balanceOf(address(this));
		savingsVault.deposit(deuroAmount, address(this));
		savingsPrincipal += deuroAmount;

		emit Levered(amount, deuroAmount);
	}

	/// @dev Unwinds up to `amount` EURC of debt by redeeming the equivalent dEURO principal out of
	///      `savingsVault`, bridging it back to EURC, and repaying Morpho. Never redeems more principal
	///      than was tracked as invested, and never repays more than is actually owed.
	function _deleverage(uint256 amount) internal {
		uint256 principal = savingsPrincipal;
		uint256 deuroNeeded = Math.min(_toDeuro(amount), principal);
		if (deuroNeeded == 0) return;

		uint256 shares = Math.min(savingsVault.previewWithdraw(deuroNeeded), savingsVault.balanceOf(address(this)));
		if (shares == 0) return;

		uint256 redeemed = savingsVault.redeem(shares, address(this), address(this));
		savingsPrincipal = principal > redeemed ? principal - redeemed : 0;

		bridge.burnAndSend(address(this), redeemed);

		uint256 eurcBalance = loanToken.balanceOf(address(this));
		uint256 debt = _debtAssets();
		uint256 repayAmount = Math.min(eurcBalance, debt);
		if (repayAmount > 0) morpho.repay(_marketParams(), repayAmount, 0, address(this), '');

		emit Delevered(repayAmount, redeemed);
	}

	/// @dev Claims savings interest accrued above `savingsPrincipal`, bridges it back to EURC, and places a
	///      CoW Swap intent selling that EURC for WBTC. The proceeds are supplied as collateral once the
	///      order settles, see {_settlePendingOrder}.
	function _reconcile() internal {
		uint256 shares = savingsVault.balanceOf(address(this));
		uint256 redeemable = savingsVault.previewRedeem(shares);
		if (redeemable <= savingsPrincipal) return;

		uint256 surplus = redeemable - savingsPrincipal;
		uint256 sharesToRedeem = Math.min(savingsVault.previewWithdraw(surplus), shares);
		uint256 claimed = savingsVault.redeem(sharesToRedeem, address(this), address(this));

		bridge.burnAndSend(address(this), claimed);

		uint256 eurcAmount = loanToken.balanceOf(address(this));
		emit InterestClaimed(claimed, eurcAmount);
		if (eurcAmount == 0) return;

		uint256 minWbtcOut = eurcAmount.mulDiv(ORACLE_SCALE, oracle.price()).mulDiv(PPM - swapSlippagePPM, PPM);
		_swap(address(loanToken), asset(), eurcAmount, minWbtcOut);
	}

	/// @dev Presigns a fill-or-kill CoW Swap sell order via GPv2Settlement.setPreSignature. The order is
	///      not executed atomically — a solver fills it (or not) over the following blocks — so
	///      {_settlePendingOrder} is what actually acts on the result.
	function _swap(address sellToken, address buyToken, uint256 sellAmount, uint256 minBuyAmount) internal {
		if (_pendingOrder.orderUid.length > 0) revert OrderPending(_pendingOrder.orderUid);

		uint32 validTo = uint32(block.timestamp) + orderValidity;
		GPv2Order.Data memory order = GPv2Order.Data({
			sellToken: IERC20(sellToken),
			buyToken: IERC20(buyToken),
			receiver: address(this),
			sellAmount: sellAmount,
			buyAmount: minBuyAmount,
			validTo: validTo,
			appData: bytes32(0),
			feeAmount: 0,
			kind: GPv2Order.KIND_SELL,
			partiallyFillable: false,
			sellTokenBalance: GPv2Order.BALANCE_ERC20,
			buyTokenBalance: GPv2Order.BALANCE_ERC20
		});

		bytes32 digest = order.hash(cowSettlement.domainSeparator());
		bytes memory orderUid = new bytes(GPv2Order.UID_LENGTH);
		GPv2Order.packOrderUidParams(orderUid, digest, address(this), validTo);

		SafeERC20.forceApprove(IERC20(sellToken), cowVaultRelayer, sellAmount);
		cowSettlement.setPreSignature(orderUid, true);

		_pendingOrder = PendingOrder({
			orderUid: orderUid,
			sellToken: sellToken,
			buyToken: buyToken,
			sellAmount: sellAmount,
			buyAmount: minBuyAmount,
			validTo: validTo
		});

		emit OrderPlaced(orderUid, sellToken, buyToken, sellAmount, minBuyAmount, validTo);
	}

	/// @dev Settles a filled order (supplying the proceeds as collateral) or cancels an expired,
	///      unfilled one, freeing `pendingOrder` either way. `received` is a snapshot of this contract's
	///      full `buyToken` balance rather than a precise per-order delta, which is exact as long as no
	///      unrelated buyToken balance is left lingering between orders — true here since WBTC is always
	///      either idle-then-supplied or freshly received from a settled order.
	function _settlePendingOrder() internal {
		PendingOrder memory order = _pendingOrder;
		if (order.orderUid.length == 0) return;

		SafeERC20.forceApprove(IERC20(order.sellToken), cowVaultRelayer, 0);

		if (cowSettlement.filledAmount(order.orderUid) > 0) {
			delete _pendingOrder;

			uint256 received = IERC20(order.buyToken).balanceOf(address(this));
			if (order.buyToken == asset() && received > 0) {
				morpho.supplyCollateral(_marketParams(), received, address(this), '');
			}
			emit OrderSettled(order.orderUid, received);
		} else {
			cowSettlement.setPreSignature(order.orderUid, false);
			cowSettlement.invalidateOrder(order.orderUid);
			delete _pendingOrder;
			emit OrderExpired(order.orderUid);
		}
	}

	// ---------------------------------------------------------------------------------------
	// ERC4626 overrides

	function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
		SafeERC20.safeTransferFrom(IERC20(asset()), caller, address(this), assets);
		morpho.supplyCollateral(_marketParams(), assets, address(this), '');
		_mint(receiver, shares);
		emit Deposit(caller, receiver, assets, shares);
	}

	/// @dev Withdraws `assets` of WBTC straight out of the Morpho collateral position. Morpho's own health
	///      check reverts if that would push the remaining position above `lltv`, so a withdrawal that
	///      needs the vault to deleverage first must wait for `rebalance()` to bring the LTV down, rather
	///      than being served as a partial fill.
	function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares) internal override {
		if (caller != owner) _spendAllowance(owner, caller, shares);
		_burn(owner, shares);
		morpho.withdrawCollateral(_marketParams(), assets, address(this), receiver);
		emit Withdraw(caller, receiver, owner, assets, shares);
	}
}
