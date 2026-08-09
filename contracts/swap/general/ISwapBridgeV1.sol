// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

import {IModuleRevenueV1} from '../../module/IModuleRevenueV1.sol';

/// @title ISwapBridgeV1
/// @notice Common swap surface shared by every swap bridge module (e.g. SwapBridgeMorphoV1): swapping a
///         trusted source coin into stablecoin and back, on top of the common IModuleRevenueV1
///         accounting/reconcile surface. A router (e.g. SwapRouterV1) forwards calls to any module
///         implementing this interface polymorphically, regardless of what backs it.
interface ISwapBridgeV1 is IModuleRevenueV1 {
	/// @notice The source coin this bridge accepts (e.g. USDC).
	function coin() external view returns (IERC20Metadata);

	/// @notice Convenience method for swapInTo(msg.sender, amount).
	function swapIn(uint256 amount) external returns (uint256);

	/// @notice Swaps `amount` of coin into stablecoin, minted to `target` minus the swap-in fee.
	/// @dev The caller must have approved this contract to pull `amount` of coin beforehand.
	function swapInTo(address target, uint256 amount) external returns (uint256);

	/// @notice Convenience method for swapOutTo(msg.sender, amount).
	function swapOut(uint256 amount) external returns (uint256);

	/// @notice Burns `amount` of stablecoin from the caller and sends the equivalent coin, minus the swap-out
	///         fee, to `target`.
	function swapOutTo(address target, uint256 amount) external returns (uint256);
}
