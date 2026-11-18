// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @title IModuleExpenseV1
/// @notice Common accounting surface for stablecoin modules that hold tracked funds and make payments against
///         them (e.g. bond-like deposits with protocol-paid interest/coupons), denominated in stablecoin units.
interface IModuleExpenseV1 {
	/// @notice An expense was paid: `amount` of `token` went to `to`. The one event every expense-side contract emits
	///         (also those that do not implement this interface, e.g. IStreamerDepositorV1 re-declares the identical
	///         signature), so an indexer needs a single handler for all of them. Counterpart of `Revenue`.
	/// @param token The token paid out (the stablecoin itself for minted expenses, e.g. coupons).
	/// @param to Recipient of the payment (a holder, or a reward vault for streamed rewards).
	/// @param amount Amount paid by this event, in `token` units.
	/// @param totalExpense Cumulative expense of the contract in `token` units, after this event. Per token, never
	///        summed across tokens, as the native stablecoins are different currencies.
	/// @param totalFunds Funds still backing future expenses in `token` units, after this event (e.g. tracked
	///        deposits for a minting module, the DAO's remaining balance for a depositor).
	event Expense(address indexed token, address indexed to, uint256 amount, uint256 totalExpense, uint256 totalFunds);

	/// @notice The module's tracked funds (e.g. user deposits), denominated in stablecoin units.
	function totalFunds() external view returns (uint256);

	/// @notice The module's lifetime expenses/payments (e.g. paid interest/coupons), denominated in stablecoin units.
	function totalExpense() external view returns (uint256);

	/// @notice The maximum totalFunds this module may hold, denominated in stablecoin units.
	function fundsCap() external view returns (uint256);

	/// @notice The maximum this module may pay out as expenses per flowPeriod, denominated in stablecoin units.
	///         Bounds the outflow, where fundsCap bounds what the module holds.
	function flowCap() external view returns (uint256);

	/// @notice Length in seconds of the window flowCap applies to. Windows are aligned to the unix epoch
	///         (`block.timestamp / flowPeriod`), so they are the same for everyone, e.g. for a UI.
	function flowPeriod() external view returns (uint256);

	/// @notice The expense still payable in the current window: flowCap minus what was already paid in it.
	function flowAvailable() external view returns (uint256);
}
