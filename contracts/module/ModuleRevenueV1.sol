// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import {IStablecoinModifier, Stablecoin} from '../stablecoin/IStablecoinModifier.sol';

import {IModuleRevenueV1} from './IModuleRevenueV1.sol';

/// @title ModuleRevenueV1
/// @author @samclassix <samclassix@proton.me>
/// @notice Abstract module implementing the minting/accounting bookkeeping side of IModuleRevenueV1. Tracks
///         totalMinted and totalRevenue, with new principal-backed issuance (via _mintWithCap) bounded by an
///         immutable mintCap set at construction — totalMinted itself can still exceed mintCap once revenue
///         reconciliation mints against already-backed surplus, which is never capped. totalAssets is left to
///         the concrete module, since only it knows how its own position is valued.
/// @dev Inherits ReentrancyGuard so reconcile() and any concrete module's own state-mutating entrypoints
///      (e.g. swapIn/swapOut) share a single nonReentrant guard across the whole contract.
abstract contract ModuleRevenueV1 is IStablecoinModifier, IModuleRevenueV1, ReentrancyGuard {
	/// @notice Thrown when a mint would push totalMinted above mintCap.
	error MintCapExceeded(uint256 requested, uint256 cap);

	/// @notice Thrown by reconcile() when called before stable.timelock() has elapsed since the last call.
	error ReconcileTooSoon(uint256 validAt);

	/// @notice Emitted when newly recognized revenue is realized, whether minted to the curator or redeemed
	///         to the curator as backing assets.
	event Revenue(uint256 amount, uint256 totalRevenue, uint256 totalMinted);

	uint256 public immutable mintCap;

	uint256 public totalMinted;
	uint256 public totalRevenue;
	uint256 public lastReconciledAt;

	// ---------------------------------------------------------------------------------------

	constructor(Stablecoin _stable, uint256 _mintCap) IStablecoinModifier(_stable) {
		mintCap = _mintCap;
	}

	// ---------------------------------------------------------------------------------------

	/// @dev Mints `amount` stablecoin to `to` unconditionally, without checking mintCap. Only safe where
	///      `amount` represents revenue rather than new principal-backed exposure — e.g. _reconcile's surplus
	///      mint (already fully backed by real totalAssets) or a swap fee split off principal that was already
	///      checked via _mintWithCap — since capping these too would be redundant at best, and at worst could
	///      block reconciliation or swaps over accrued interest alone. Use _mintWithCap for anything that isn't
	///      already backed or already checked.
	function _mint(address to, uint256 amount) internal {
		totalMinted += amount;
		stable.mintModule(to, amount);
	}

	/// @dev Mints `amount` stablecoin to `to`, reverting if doing so would push totalMinted above mintCap.
	function _mintWithCap(address to, uint256 amount) internal {
		uint256 newTotalMinted = totalMinted + amount;
		if (newTotalMinted > mintCap) revert MintCapExceeded(newTotalMinted, mintCap);

		_mint(to, amount);
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Recognizes accrued totalAssets growth as revenue, minted to the curator when possible.
	///         Permissionless, throttled to at most once per stable.timelock(). If this module is no longer a
	///         valid (non-expired) minter, _reconcile automatically falls back to redeeming the surplus
	///         instead of minting it, so this stays safely callable by anyone even after expiry.
	function reconcile() external nonReentrant {
		_reconcileWithGuard(true, false);
	}

	/// @dev Runs _reconcile() if at least stable.timelock() has elapsed since the last successful call. When
	///      `allowPassing` is true, an elapsed-guard failure is silently skipped instead of reverting, letting a
	///      caller reconcile opportunistically without risking its own transaction.
	function _reconcileWithGuard(bool allowMinting, bool allowPassing) internal {
		uint256 validAt = lastReconciledAt + stable.timelock();
		if (block.timestamp < validAt) {
			if (allowPassing) return;
			revert ReconcileTooSoon(validAt);
		}

		_reconcile(allowMinting);
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Recognizes accrued totalAssets growth as revenue, explicitly choosing whether to mint it
	///         (`allowMinting`) or redeem it out of the backing position instead (e.g. a vault position),
	///         without minting. Curator-gated: unlike the auto-selected fallback in reconcile(), deliberately
	///         forcing the redeem path pulls capital out of the backing position, and a permissionless caller
	///         could time that adversarially. Not throttled by stable.timelock() — that guard exists to stop
	///         spam from arbitrary permissionless callers, which doesn't apply to the curator's own action.
	function reconcile(bool allowMinting) external onlyCurator nonReentrant {
		_reconcile(allowMinting);
	}

	/// @dev Reconciles totalMinted with the module's current totalAssets: if assets have grown beyond what's
	///      been minted so far (e.g. accrued interest), realizes the deficit as revenue to the curator — either
	///      minted or redeemed out of the backing position directly, depending on `allowMinting`. No-op if
	///      totalAssets has not grown past totalMinted.
	/// @dev The mint here is uncapped (via _mint, not _mintWithCap): it only ever mints against a deficit that
	///      already exists as real backing (totalAssets already covers it), so it can't create unbacked
	///      stablecoin regardless of mintCap — mintCap instead bounds principal-backed issuance from swapIn.
	///      Capping this path too would only reintroduce the risk that unrecognized interest alone
	///      permanently blocks reconciliation once totalMinted nears the cap.
	/// @dev Updates lastReconciledAt unconditionally on every call (not just via _reconcileWithGuard), so the
	///      throttle stays accurate even when a caller (e.g. the curator-gated reconcile(bool) overload)
	///      invokes this directly, bypassing the guard.
	/// @dev If `allowMinting` is requested but this module is no longer a valid (non-expired) minter, silently
	///      falls back to the redeem path instead of reverting — minting would fail anyway, and there's no
	///      reason to block reconciliation just because minting specifically isn't available right now.
	function _reconcile(bool allowMinting) internal {
		lastReconciledAt = block.timestamp;

		uint256 assets = this.totalAssets();
		if (assets <= totalMinted) return;

		uint256 deficit = assets - totalMinted;
		totalRevenue += deficit;

		if (allowMinting && !stable.checkValidModule(address(this))) allowMinting = false;

		if (allowMinting) {
			_mint(stable.curator(), deficit);
		} else {
			_redeemAssets(deficit);
		}

		emit Revenue(deficit, totalRevenue, totalMinted);
	}

	// ---------------------------------------------------------------------------------------

	/// @dev Redeems `amount` (denominated in stablecoin units) worth of whatever backs this module (e.g. a
	///      vault position) straight to the curator, without minting. Left to the concrete module, since only
	///      it knows how to convert a stablecoin-denominated amount into its own backing.
	function _redeemAssets(uint256 amount) internal virtual;
}
