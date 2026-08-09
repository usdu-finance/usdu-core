// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IStablecoinModifier, Stablecoin} from '../stablecoin/IStablecoinModifier.sol';

import {IModuleExpense} from './IModuleExpense.sol';

// TODO: verify code and evtl bug fixes

/// @title ModuleExpenseV1
/// @author @samclassix <samclassix@proton.me>
/// @notice Abstract module implementing the expense bookkeeping side of IModuleExpense. Tracks totalExpense
///         and offers a fundsCap guard; totalFunds is left to the concrete module, since only it knows how
///         its own held/deployed funds are valued.
abstract contract ModuleExpenseV1 is IStablecoinModifier, IModuleExpense {
	/// @notice Thrown when funding would push totalFunds above fundsCap.
	error FundsCapExceeded(uint256 requested, uint256 cap);

	/// @notice Emitted when an expense (e.g. interest/coupon) is paid out.
	event Expense(uint256 amount, uint256 totalExpense, uint256 totalFunds);

	uint256 public immutable fundsCap;

	uint256 public totalExpense;

	// ---------------------------------------------------------------------------------------

	constructor(Stablecoin _stable, uint256 _fundsCap) IStablecoinModifier(_stable) {
		fundsCap = _fundsCap;
	}

	// ---------------------------------------------------------------------------------------

	/// @dev Reverts if totalFunds is currently above fundsCap.
	function _verifyCap() internal view {
		uint256 newTotalFunds = this.totalFunds();
		if (newTotalFunds > fundsCap) revert FundsCapExceeded(newTotalFunds, fundsCap);
	}

	/// @dev Pays `amount` as a protocol-funded expense (e.g. interest/coupon) to `to`.
	function _expense(address to, uint256 amount) internal {
		totalExpense += amount;
		stable.mintModule(to, amount);
		emit Expense(amount, totalExpense, this.totalFunds());
	}
}
