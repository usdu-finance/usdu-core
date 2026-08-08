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

	/// @notice Emitted when newly recognized revenue is minted to the curator.
	event Revenue(uint256 amount, uint256 totalRevenue, uint256 totalMinted);

	uint256 public immutable mintCap;

	uint256 public totalMinted;
	uint256 public totalRevenue;

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

	/// @dev Reconciles totalMinted with the module's current totalAssets: if assets have grown beyond what's
	///      been minted so far (e.g. accrued interest), mints the deficit straight to the curator and
	///      recognizes it as revenue. No-op if totalAssets has not grown past totalMinted.
	function _reconcile() internal {
		uint256 assets = this.totalAssets();
		if (assets <= totalMinted) return;

		uint256 deficit = assets - totalMinted;
		totalRevenue += deficit;
		_mint(stable.curator(), deficit);
		emit Revenue(deficit, totalRevenue, totalMinted);
	}
}
