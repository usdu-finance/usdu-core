// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @title IModuleExpense
/// @notice Common accounting surface for stablecoin modules that hold tracked funds and make payments against
///         them (e.g. bond-like deposits with protocol-paid interest/coupons), denominated in stablecoin units.
interface IModuleExpense {
	/// @notice The module's tracked funds (e.g. user deposits), denominated in stablecoin units.
	function totalFunds() external view returns (uint256);

	/// @notice The module's lifetime expenses/payments (e.g. paid interest/coupons), denominated in stablecoin units.
	function totalExpense() external view returns (uint256);
}
