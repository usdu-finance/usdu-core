// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';

import {ISwapBridgeV1} from '../general/ISwapBridgeV1.sol';

/// @title ISwapBridgeMorphoV1
/// @notice Morpho-specific extension of ISwapBridgeV1: a stablecoin bridge for a trusted source coin (e.g.
///         USDC) into an ERC4626 vault (e.g. a Morpho Vault V2).
interface ISwapBridgeMorphoV1 is ISwapBridgeV1 {
	/// @notice The ERC4626 vault the coin is deposited into (e.g. a Morpho Vault V2).
	function vault() external view returns (IERC4626);

	/// @notice The fee for swapping coin into stablecoin, in parts per million.
	function swapInFeePPM() external view returns (uint24);

	/// @notice The fee for swapping stablecoin back into coin, in parts per million.
	function swapOutFeePPM() external view returns (uint24);
}
