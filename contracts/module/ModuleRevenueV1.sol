// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IStablecoinModifier, Stablecoin} from '../stablecoin/IStablecoinModifier.sol';

import {IModuleRevenue} from './IModuleRevenue.sol';

/// @title ModuleRevenueV1
/// @author @samclassix <samclassix@proton.me>
/// @notice Abstract module implementing the minting/accounting bookkeeping side of IModuleRevenue. Tracks
///         totalMinted and totalRevenue against an immutable mintCap set at construction. totalAssets is
///         left to the concrete module, since only it knows how its own position is valued.
abstract contract ModuleRevenueV1 is IStablecoinModifier, IModuleRevenue {
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

	/// @dev Mints `amount` stablecoin to `to`, reverting if doing so would push totalMinted above mintCap.
	function _mint(address to, uint256 amount) internal {
		uint256 newTotalMinted = totalMinted + amount;
		if (newTotalMinted > mintCap) revert MintCapExceeded(newTotalMinted, mintCap);

		totalMinted = newTotalMinted;
		stable.mintModule(to, amount);
	}

	/// @notice Recognizes accrued totalAssets growth as revenue, minted to the curator. Permissionless, but
	///         throttled to at most once per stable.timelock() to keep it from being spammed; reverts if
	///         called again too soon.
	function reconcile() external {
		_reconcileWithGuard(false);
	}

	/// @dev Runs _reconcile() if at least stable.timelock() has elapsed since the last successful call. When
	///      `pass` is true, an elapsed-guard failure is silently skipped instead of reverting, letting a
	///      caller reconcile opportunistically without risking its own transaction.
	function _reconcileWithGuard(bool pass) internal {
		uint256 validAt = lastReconciledAt + stable.timelock();
		if (block.timestamp < validAt) {
			if (pass) return;
			revert ReconcileTooSoon(validAt);
		}

		lastReconciledAt = block.timestamp;
		_reconcile();
	}

	/// @dev Reconciles totalMinted with the module's current totalAssets: if assets have grown beyond what's
	///      been minted so far (e.g. accrued interest), mints the deficit straight to the curator and
	///      recognizes it as revenue. No-op if totalAssets has not grown past totalMinted.
	/// @dev The mintable amount is clamped to the headroom left under mintCap rather than reverting, so that
	///      accrued interest alone can never permanently block reconciliation (or callers that reconcile
	///      opportunistically, e.g. before minting more). Any unrecognized remainder is picked up on a later
	///      call once headroom opens back up.
	function _reconcile() internal {
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
