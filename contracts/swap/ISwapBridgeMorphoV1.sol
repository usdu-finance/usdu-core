// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';

import {IModuleRevenueV1} from '../module/IModuleRevenueV1.sol';

/// @title ISwapBridgeMorphoV1
/// @notice Accounting and action surface for a SwapBridgeMorphoV1 instance: a stablecoin bridge for a trusted
///         source coin (e.g. USDC) into an ERC4626 vault (e.g. a Morpho Vault V2), on top of the common
///         IModuleRevenueV1 accounting/reconcile surface.
interface ISwapBridgeMorphoV1 is IModuleRevenueV1 {
	/// @notice The source coin this bridge accepts (e.g. USDC).
	function coin() external view returns (IERC20Metadata);

	/// @notice The ERC4626 vault the coin is deposited into (e.g. a Morpho Vault V2).
	function vault() external view returns (IERC4626);

	/// @notice The fee for swapping coin into stablecoin, in parts per million.
	function swapInFeePPM() external view returns (uint24);

	/// @notice The fee for swapping stablecoin back into coin, in parts per million.
	function swapOutFeePPM() external view returns (uint24);

	/// @notice Convenience method for swapInTo(msg.sender, amount).
	function swapIn(uint256 amount) external returns (uint256);

	/// @notice Swaps `amount` of coin into stablecoin, minted to `target` minus the swap-in fee.
	/// @dev The caller must have approved this contract to pull `amount` of coin beforehand.
	function swapInTo(address target, uint256 amount) external returns (uint256);

	/// @notice Convenience method for swapOutTo(msg.sender, amount).
	function swapOut(uint256 amount) external returns (uint256);

	/// @notice Burns `amount` of stablecoin from the caller and sends the equivalent coin, minus the swap-out
	///         fee, to `target`. The fee is taken in coin (not minted), so this never depends on the module
	///         still being a valid minter — it keeps working even after this module has expired.
	function swapOutTo(address target, uint256 amount) external returns (uint256);
}
