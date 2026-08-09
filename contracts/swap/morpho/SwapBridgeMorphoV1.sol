// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {ModuleRevenueV1, Stablecoin} from '../../module/ModuleRevenueV1.sol';

import {ISwapBridgeMorphoV1} from './ISwapBridgeMorphoV1.sol';

/**
 * @title SwapBridgeMorphoV1
 * @author @samclassix <samclassix@proton.me>
 * @notice A stablecoin bridge for a trusted source coin (e.g. USDC): swapping in mints stablecoin 1:1 minus a
 *         fee and puts the coin to work in an ERC4626 vault (e.g. a Morpho Vault V2); swapping out redeems the
 *         position and burns the stablecoin, taking its fee in coin rather than minting. Both swap directions
 *         opportunistically reconcile accrued vault interest as revenue, either minted to the curator or
 *         redeemed as coin depending on whether the module is still a valid minter — so swapOut in particular
 *         never depends on that validity to succeed, and keeps working even after this module has expired.
 */
contract SwapBridgeMorphoV1 is ModuleRevenueV1, ISwapBridgeMorphoV1 {
	using Math for uint256;
	using SafeERC20 for IERC20Metadata;

	/// @notice The source coin this bridge accepts (e.g. USDC).
	IERC20Metadata public immutable coin;

	/// @notice The ERC4626 vault the coin is deposited into (e.g. a Morpho Vault V2).
	IERC4626 public immutable vault;

	/// @notice The fee for swapping coin into stablecoin, in parts per million.
	uint24 public immutable swapInFeePPM;

	/// @notice The fee for swapping stablecoin back into coin, in parts per million.
	uint24 public immutable swapOutFeePPM;

	// ---------------------------------------------------------------------------------------

	event SwapIn(address indexed target, uint256 amountCoin, uint256 amountStable, uint256 fee);
	event SwapOut(address indexed target, uint256 amountStable, uint256 amountCoin, uint256 fee);

	// ---------------------------------------------------------------------------------------

	error InvalidFee(uint24 feePPM);

	// ---------------------------------------------------------------------------------------

	constructor(
		Stablecoin _stable,
		IERC4626 _vault,
		uint256 _mintCap,
		uint24 _swapInFeePPM,
		uint24 _swapOutFeePPM
	) ModuleRevenueV1(_stable, _mintCap) {
		if (_swapInFeePPM > 1_000_000) revert InvalidFee(_swapInFeePPM);
		if (_swapOutFeePPM > 1_000_000) revert InvalidFee(_swapOutFeePPM);

		coin = IERC20Metadata(_vault.asset());
		vault = _vault;
		swapInFeePPM = _swapInFeePPM;
		swapOutFeePPM = _swapOutFeePPM;
	}

	// ---------------------------------------------------------------------------------------

	/// @notice The bridge's assets, i.e. the coin held in the vault, denominated in stablecoin units.
	function totalAssets() public view override returns (uint256) {
		return (vault.convertToAssets(vault.balanceOf(address(this))) * 1 ether) / 10 ** coin.decimals();
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Convenience method for swapInTo(msg.sender, amount).
	function swapIn(uint256 amount) external nonReentrant returns (uint256) {
		return _swapIn(_msgSender(), amount);
	}

	/// @notice Swaps `amount` of coin into stablecoin, minted to `target` minus the swap-in fee.
	/// @dev The caller must have approved this contract to pull `amount` of coin beforehand.
	function swapInTo(address target, uint256 amount) external nonReentrant returns (uint256) {
		return _swapIn(target, amount);
	}

	function _swapIn(address target, uint256 amount) internal returns (uint256) {
		_reconcileWithGuard(true, true);

		coin.safeTransferFrom(_msgSender(), address(this), amount);

		coin.forceApprove(address(vault), amount);
		vault.deposit(amount, address(this));

		uint256 amountStable = (amount * 1 ether) / 10 ** coin.decimals();
		uint256 fee = amountStable.mulDiv(swapInFeePPM, 1_000_000);

		_mintWithCap(target, amountStable - fee);
		_mint(stable.curator(), fee);
		totalRevenue += fee;

		emit SwapIn(target, amount, amountStable, fee);
		return amountStable - fee;
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Convenience method for swapOutTo(msg.sender, amount).
	function swapOut(uint256 amount) external nonReentrant returns (uint256) {
		return _swapOut(_msgSender(), amount);
	}

	/// @notice Burns `amount` of stablecoin from the caller and sends the equivalent coin, minus the swap-out
	///         fee, to `target`. The fee itself is taken in coin, never minted; the opportunistic reconcile
	///         this triggers can still mint surplus while the module is valid, but auto-falls-back to
	///         redeeming once expired (see _reconcile) — so this keeps working even after this module expires.
	function swapOutTo(address target, uint256 amount) external nonReentrant returns (uint256) {
		return _swapOut(target, amount);
	}

	function _swapOut(address target, uint256 amount) internal returns (uint256) {
		// opportunistically mints accrued surplus to the curator as stablecoin while the module is valid, so
		// yield stays invested/composable rather than being forced out as coin on every swapOut; throttled and
		// silently skipped if stable.timelock() hasn't elapsed (consistent with every other reconcile
		// entrypoint, and cheaper on repeat swapOuts within the same window). _reconcile's own validModule
		// check auto-falls-back to redeeming instead once this module has expired, so this never reintroduces
		// a mintModule dependency for the redemption path itself.
		_reconcileWithGuard(true, true);

		stable.burnModule(_msgSender(), amount);
		totalMinted -= amount;

		uint256 fee = amount.mulDiv(swapOutFeePPM, 1_000_000);
		totalRevenue += fee;

		uint256 amountCoin = ((amount - fee) * 10 ** coin.decimals()) / 1 ether;
		uint256 feeCoin = (fee * 10 ** coin.decimals()) / 1 ether;

		vault.withdraw(amountCoin, target, address(this));
		if (feeCoin > 0) vault.withdraw(feeCoin, stable.curator(), address(this));

		emit SwapOut(target, amount, amountCoin, fee);
		return amountCoin;
	}

	// ---------------------------------------------------------------------------------------

	/// @dev Redeems `amount` (denominated in stablecoin units) worth of this bridge's vault position, sending
	///      the resulting coin straight to the curator.
	function _redeemAssets(uint256 amount) internal override {
		uint256 amountCoin = (amount * 10 ** coin.decimals()) / 1 ether;
		if (amountCoin == 0) return;

		vault.withdraw(amountCoin, stable.curator(), address(this));
	}
}
