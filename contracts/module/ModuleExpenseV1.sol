// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IStablecoinModifier, IStablecoinMetadata} from '../stablecoin/IStablecoinModifier.sol';

import {IModuleExpenseV1} from './IModuleExpenseV1.sol';

/// @title ModuleExpenseV1
/// @author @samclassix <integration@usdu.finance>
/// @notice Abstract module implementing the expense bookkeeping side of IModuleExpenseV1. Tracks totalExpense
///         and offers two guards: a fundsCap on what the module holds and a flowCap on what it pays out per
///         flowPeriod; totalFunds is left to the concrete module, since only it knows how
///         its own held/deployed funds are valued.
/// @dev DRAFT: no contract uses this yet, and the flow cap in particular has no test. Paying expenses by minting
///      (`_expense` mints via `mintModule`) is not settled as the right model, so expect this to change or to be
///      dropped. Do not build on it before it is reviewed and covered by tests. StreamerDepositorV1 deliberately does
///      not use it (it spends the DAO's existing balance); it only shares the `Expense` event.
abstract contract ModuleExpenseV1 is IStablecoinModifier, IModuleExpenseV1 {
	/// @notice Thrown when funding would push totalFunds above fundsCap.
	error FundsCapExceeded(uint256 requested, uint256 cap);

	/// @notice Thrown when an expense would push the current window's payouts above flowCap.
	error FlowCapExceeded(uint256 requested, uint256 available);

	error ZeroFlowPeriod();

	uint256 public immutable fundsCap;
	uint256 public immutable flowCap;
	uint256 public immutable flowPeriod;

	uint256 public totalExpense;

	/// @dev Window the payouts in `flowExpense` belong to (`block.timestamp / flowPeriod`)
	uint256 private flowEpoch;
	uint256 private flowExpense;

	// ---------------------------------------------------------------------------------------

	constructor(IStablecoinMetadata _stable, uint256 _fundsCap, uint256 _flowCap, uint256 _flowPeriod) IStablecoinModifier(_stable) {
		if (_flowPeriod == 0) revert ZeroFlowPeriod();
		fundsCap = _fundsCap;
		flowCap = _flowCap;
		flowPeriod = _flowPeriod;
	}

	// ---------------------------------------------------------------------------------------

	/// @inheritdoc IModuleExpenseV1
	function flowAvailable() public view returns (uint256) {
		uint256 spent = block.timestamp / flowPeriod == flowEpoch ? flowExpense : 0;
		return spent >= flowCap ? 0 : flowCap - spent;
	}

	// ---------------------------------------------------------------------------------------

	/// @dev Reverts if totalFunds is currently above fundsCap.
	function _verifyCap() internal view {
		uint256 newTotalFunds = this.totalFunds();
		if (newTotalFunds > fundsCap) revert FundsCapExceeded(newTotalFunds, fundsCap);
	}

	/// @dev Pays `amount` as a protocol-funded expense (e.g. interest/coupon) to `to`. Reverts if it would push the
	///      current window's payouts above flowCap. Fixed windows allow up to 2x flowCap across a window boundary.
	function _expense(address to, uint256 amount) internal {
		uint256 available = flowAvailable();
		if (amount > available) revert FlowCapExceeded(amount, available);

		uint256 epoch = block.timestamp / flowPeriod;
		flowExpense = (epoch == flowEpoch ? flowExpense : 0) + amount;
		flowEpoch = epoch;

		totalExpense += amount;
		stable.mintModule(to, amount);
		emit Expense(address(stable), to, amount, totalExpense, this.totalFunds());
	}
}
