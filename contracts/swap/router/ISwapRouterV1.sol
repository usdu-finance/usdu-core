// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IStablecoin} from '../../stablecoin/IStablecoin.sol';

import {ISwapBridgeV1} from '../general/ISwapBridgeV1.sol';

/// @title ISwapRouterV1
/// @notice Entrypoint surface for SwapRouterV1: a stateless, non-custodial router that forwards swapIn/swapOut
///         calls to any ISwapBridgeV1 module registered on `stable`, plus a batched execute() for running
///         several swaps - through possibly different modules - in a single transaction.
interface ISwapRouterV1 {
	/// @notice The stablecoin whose registered modules this router may forward calls to.
	function stable() external view returns (IStablecoin);

	/// @notice Convenience method for swapInTo(module, msg.sender, amount).
	function swapIn(ISwapBridgeV1 module, uint256 amount) external returns (uint256);

	/// @notice Swaps `amount` of `module`'s coin into stablecoin via `module`, minted to `target` minus its
	///         swap-in fee.
	/// @dev The caller must have approved this router to pull `amount` of `module`'s coin beforehand.
	function swapInTo(ISwapBridgeV1 module, address target, uint256 amount) external returns (uint256);

	/// @notice Convenience method for swapOutTo(module, msg.sender, amount).
	function swapOut(ISwapBridgeV1 module, uint256 amount) external returns (uint256);

	/// @notice Burns `amount` of stablecoin from the caller and sends the equivalent coin, minus `module`'s
	///         swap-out fee, to `target`.
	function swapOutTo(ISwapBridgeV1 module, address target, uint256 amount) external returns (uint256);

	/// @notice Batches multiple swaps into a single transaction, each independently a swapIn or a swapOut and
	///         each free to go through a different module. Swap `i` is described by `modules[i]`, `targets[i]`,
	///         `amounts[i]` and `isSwapIn[i]`; all four arrays must have the same length. The whole batch
	///         reverts if any single swap in it fails.
	/// @dev The caller must have approved this router beforehand for the sum of whatever coin(s)/stablecoin
	///      each swapIn/swapOut in the batch will pull from them.
	function execute(
		ISwapBridgeV1[] calldata modules,
		address[] calldata targets,
		uint256[] calldata amounts,
		bool[] calldata isSwapIn
	) external returns (uint256[] memory amountsOut);
}
