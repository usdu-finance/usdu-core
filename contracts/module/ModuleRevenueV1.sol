// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import {IStablecoinModifier, Stablecoin} from '../stablecoin/IStablecoinModifier.sol';

import {IModuleRevenueV1} from './IModuleRevenueV1.sol';

/// @title ModuleRevenueV1
/// @author @samclassix <samclassix@proton.me>
/// @notice Abstract module implementing the minting/accounting bookkeeping side of IModuleRevenueV1. Tracks
///         totalMinted and totalRevenue against an immutable mintCap set at construction. totalAssets is
///         left to the concrete module, since only it knows how its own position is valued.
/// @dev Inherits ReentrancyGuard so reconcile() and any concrete module's own state-mutating entrypoints
///      (e.g. swapIn/swapOut) share a single nonReentrant guard across the whole contract.
abstract contract ModuleRevenueV1 is IStablecoinModifier, IModuleRevenueV1, ReentrancyGuard {
	/// @notice Thrown when a mint would push totalMinted above mintCap.
	error MintCapExceeded(uint256 requested, uint256 cap);

	/// @notice Thrown by reconcile() when called before stable.timelock() has elapsed since the last call.
	error ReconcileTooSoon(uint256 validAt);

	/// @notice Emitted when newly recognized revenue is minted to the curator.
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

	/// @dev Mints `amount` stablecoin to `to` unconditionally, without checking mintCap. Only safe where the
	///      caller already guarantees `amount` cannot push totalMinted above mintCap (e.g. a net-decreasing
	///      mint, or an amount already clamped to remaining headroom) — use _mintWithCap otherwise.
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

	/// @notice Recognizes accrued totalAssets growth as revenue, minted to the curator. Permissionless, but
	///         throttled to at most once per stable.timelock() to keep it from being spammed; reverts if
	///         called again too soon.
	function reconcile() external nonReentrant {
		_reconcileWithGuard(false);
	}

	/// @dev Runs _reconcile() if at least stable.timelock() has elapsed since the last successful call. When
	///      `allowPassing` is true, an elapsed-guard failure is silently skipped instead of reverting, letting a
	///      caller reconcile opportunistically without risking its own transaction.
	function _reconcileWithGuard(bool allowPassing) internal {
		uint256 validAt = lastReconciledAt + stable.timelock();
		if (block.timestamp < validAt) {
			if (allowPassing) return;
			revert ReconcileTooSoon(validAt);
		}

		_reconcile();
	}

	/// @dev Reconciles totalMinted with the module's current totalAssets: if assets have grown beyond what's
	///      been minted so far (e.g. accrued interest), mints the deficit straight to the curator and
	///      recognizes it as revenue. No-op if totalAssets has not grown past totalMinted.
	/// @dev The mintable amount is clamped to the headroom left under mintCap rather than reverting, so that
	///      accrued interest alone can never permanently block reconciliation (or callers that reconcile
	///      opportunistically, e.g. before minting more). Any unrecognized remainder is picked up on a later
	///      call once headroom opens back up.
	/// @dev Updates lastReconciledAt unconditionally on every call (not just via _reconcileWithGuard), so the
	///      throttle stays accurate even when a caller (e.g. swapOut) invokes this directly, bypassing the guard.
	function _reconcile() internal {
		lastReconciledAt = block.timestamp;

		uint256 assets = this.totalAssets();
		if (assets <= totalMinted) return;

		uint256 deficit = assets - totalMinted;
		uint256 headroom = mintCap - totalMinted;
		uint256 mintable = deficit < headroom ? deficit : headroom;
		if (mintable == 0) return;

		totalRevenue += mintable;
		_mint(stable.curator(), mintable);
		emit Revenue(mintable, totalRevenue, totalMinted);
	}
}
