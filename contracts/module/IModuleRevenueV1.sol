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

	/// @notice The maximum amount this module may mint against new deposits, denominated in stablecoin units.
	///         totalMinted can still exceed this once revenue reconciliation mints against already-backed
	///         surplus (see reconcile()), which is never capped since it can't create unbacked stablecoin.
	function mintCap() external view returns (uint256);

	/// @notice Timestamp of the last successful reconcile() call.
	function lastReconciledAt() external view returns (uint256);

	/// @notice Recognizes accrued totalAssets growth as revenue, minted to the curator when possible
	///         (auto-falls back to redeeming instead of minting once this module is no longer a valid minter).
	function reconcile() external;

	/// @notice Recognizes accrued totalAssets growth as revenue, explicitly choosing whether to mint it
	///         (allowMinting) or redeem it out of whatever backs this module instead, without minting.
	function reconcile(bool allowMinting) external;
}
