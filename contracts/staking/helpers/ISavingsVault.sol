// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';

import {ISavingsDEURO} from './ISavingsDEURO.sol';

interface ISavingsVault is IERC4626 {
	struct Info {
		uint256 balance; // total in savings
		uint256 unclaimed; // unclaimed interest, not yet accrued to the price
		uint256 pendingFeeAssets; // performance/license fee owed on revenue accrued since the last reconcile, in assets
		uint256 pendingFeeShares; // the above, in the vault shares reconcile() would mint to feeRecipient right now
		uint256 currentRate; // current yield, in 1e18
		uint256 feeRate; // current fee, in 1e18
		uint256 totalRevenue; // total revenue generated since inception
		uint256 totalFees; // total performance/license fees credited to the fee recipient as shares, valued at mint time
		uint256 price; // current price per share
	}

	// ---------------------------------------------------------------------------------------

	event FeeRecipientChanged(address indexed previousRecipient, address indexed newRecipient);
	event FeeChanged(uint256 previousFee, uint256 newFee);
	event Reconciled(uint256 revenue, uint256 feeAssets, uint256 feeShares, uint256 price);

	// ---------------------------------------------------------------------------------------

	error FeeTooHigh(uint256 requested, uint256 cap);

	// ---------------------------------------------------------------------------------------

	function savings() external view returns (ISavingsDEURO);

	function feeRecipient() external view returns (address);

	function fee() external view returns (uint256);

	function MAX_FEE() external view returns (uint256);

	function info() external view returns (Info memory);

	function price() external view returns (uint256);

	// ---------------------------------------------------------------------------------------

	function setFeeRecipient(address newRecipient) external;

	function setFee(uint256 newFee) external;

	function reconcile() external;
}
