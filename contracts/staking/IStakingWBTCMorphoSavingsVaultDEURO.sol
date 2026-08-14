// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';

import {IMorpho, Id} from '../morpho/helpers/IMorpho.sol';
import {IGPv2Settlement} from '../cow/helpers/IGPv2Settlement.sol';
import {IStablecoinBridge} from './helpers/IStablecoinBridge.sol';
import {ISavingsVault} from './helpers/ISavingsVault.sol';

interface IStakingWBTCMorphoSavingsVaultDEURO is IERC4626 {
	/// @notice The action _checkRebalance would take (or just took) the next time it runs. Only one action
	///         is taken per rebalance() call; a keeper should keep calling until this reads NONE.
	enum Action {
		NONE,
		SETTLE, // a placed CoW order is filled or expired and needs to be settled/cancelled
		RECONCILE, // savings position has redeemable interest above savingsPrincipal, worth claiming
		LEVERAGE, // LTV is below targetLtv - targetBand
		DELEVERAGE // LTV is above targetLtv + targetBand
	}

	/// @notice A CoW Swap intent this vault has presigned and is waiting for a solver to fill.
	struct PendingOrder {
		bytes orderUid;
		address sellToken;
		address buyToken;
		uint256 sellAmount;
		uint256 buyAmount;
		uint32 validTo;
	}

	// ---------------------------------------------------------------------------------------

	event Levered(uint256 borrowedEurc, uint256 investedDeuro);
	event Delevered(uint256 repaidEurc, uint256 withdrawnDeuro);
	event InterestClaimed(uint256 claimedDeuro, uint256 claimedEurc);
	event OrderPlaced(bytes orderUid, address sellToken, address buyToken, uint256 sellAmount, uint256 minBuyAmount, uint32 validTo);
	event OrderSettled(bytes orderUid, uint256 received);
	event OrderExpired(bytes orderUid);
	event Rebalanced(Action action);
	event TargetLtvChanged(uint256 previousLtv, uint256 newLtv);
	event TargetBandChanged(uint256 previousBand, uint256 newBand);
	event SwapSlippageChanged(uint256 previousSlippagePPM, uint256 newSlippagePPM);
	event OrderValidityChanged(uint32 previousValidity, uint32 newValidity);

	// ---------------------------------------------------------------------------------------

	error LtvOutOfBounds(uint256 targetLtv, uint256 targetBand, uint256 lltv);
	error SlippageTooHigh(uint256 requested, uint256 cap);
	error OrderPending(bytes orderUid);
	error InvalidMarket();

	// ---------------------------------------------------------------------------------------

	function morpho() external view returns (IMorpho);

	function marketId() external view returns (Id);

	function bridge() external view returns (IStablecoinBridge);

	function savingsVault() external view returns (ISavingsVault);

	function cowSettlement() external view returns (IGPv2Settlement);

	function targetLtv() external view returns (uint256);

	function targetBand() external view returns (uint256);

	function swapSlippagePPM() external view returns (uint256);

	function orderValidity() external view returns (uint32);

	/// @notice The dEURO principal this vault has deposited into `savingsVault`, tracked so that
	///         redeemable value above this line can be recognized as claimable interest.
	function savingsPrincipal() external view returns (uint256);

	function pendingOrder() external view returns (PendingOrder memory);

	/// @notice Returns the action _checkRebalance would take right now, without executing it.
	function checkRebalance() external view returns (Action);

	/// @notice Permissionlessly executes the single next rebalance action (settle/reconcile/leverage/
	///         deleverage), if any. Callable by anyone, e.g. a keeper bot; a no-op (Action.NONE) when the
	///         position is already within targetLtv +/- targetBand and there is nothing to settle or claim.
	function rebalance() external returns (Action);

	function setTargetLtv(uint256 newTargetLtv) external;

	function setTargetBand(uint256 newTargetBand) external;

	function setSwapSlippagePPM(uint256 newSlippagePPM) external;

	function setOrderValidity(uint32 newValidity) external;
}
