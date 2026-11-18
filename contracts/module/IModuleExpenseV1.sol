// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IModuleExpenseEventsV1} from './IModuleExpenseEventsV1.sol';

/// @title IModuleExpenseV1
/// @notice Common accounting surface for stablecoin modules that hold tracked funds and make payments against
///         them (e.g. bond-like deposits with protocol-paid interest/coupons), denominated in stablecoin units.
interface IModuleExpenseV1 is IModuleExpenseEventsV1 {
	/// @notice The module's tracked funds (e.g. user deposits), denominated in stablecoin units.
	function totalFunds() external view returns (uint256);

	/// @notice The module's lifetime expenses/payments (e.g. paid interest/coupons), denominated in stablecoin units.
	function totalExpense() external view returns (uint256);

	/// @notice The maximum totalFunds this module may hold, denominated in stablecoin units.
	function fundsCap() external view returns (uint256);
}
