// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @title IModuleRevenueV1
/// @notice Common accounting surface for stablecoin modules, exposing assets, liabilities and revenue in
///         stablecoin units so callers (e.g. a registry, dashboard, or keeper) can read and reconcile any
///         module polymorphically.
interface IModuleRevenueV1 {
	/// @notice The module's assets, denominated in stablecoin units.
	function totalAssets() external view returns (uint256);

	/// @notice The module's liabilities, denominated in stablecoin units (i.e. outstanding minted stablecoin).
	function totalMinted() external view returns (uint256);

	/// @notice The module's lifetime revenue/profit, denominated in stablecoin units.
	function totalRevenue() external view returns (uint256);

	/// @notice The maximum amount this module may mint, denominated in stablecoin units.
	function mintCap() external view returns (uint256);

	/// @notice Timestamp of the last successful reconcile() call.
	function lastReconciledAt() external view returns (uint256);

	/// @notice Recognizes accrued totalAssets growth as revenue, minted to the curator.
	function reconcile() external;
}
