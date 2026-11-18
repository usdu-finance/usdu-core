// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @title IModuleExpenseEventsV1
/// @notice The one event every expense-side contract emits when it pays out, so an indexer (and the UI on top of
///         it) needs a single handler for all of them. The counterpart of the `Revenue` event on the revenue side.
interface IModuleExpenseEventsV1 {
	/// @notice An expense was paid: `amount` of `token` went to `to`.
	/// @param token The token paid out (the stablecoin itself for minted expenses, e.g. coupons).
	/// @param to Recipient of the payment (a holder, or a reward vault for streamed rewards).
	/// @param amount Amount paid by this event, in `token` units.
	/// @param totalExpense Cumulative expense of this contract in `token` units, after this event. Per token, never
	///        summed across tokens, as the native stablecoins are different currencies.
	/// @param totalFunds Funds still backing future expenses in `token` units, after this event (e.g. tracked
	///        deposits for a minting module, the DAO's remaining balance for a depositor).
	event Expense(address indexed token, address indexed to, uint256 amount, uint256 totalExpense, uint256 totalFunds);
}
