// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Stablecoin, IERC20, IERC4626, VaultAdapterV1, SafeERC20} from './VaultAdapterV1.sol';

/**
 * @title VaultAdapterRecoverV1
 * @author @samclassix <samclassix@proton.me>
 * @notice This contract serves as an adapter for interacting with vaults, facilitating the direct minting of liquidity into them.
 * @notice It includes a recovery mechanism designed to handle edge cases for collateral as Real-World Assets (RWA), specifically for KYC-approved users during liquidation events.
 */
contract VaultAdapterRecoverV1 is VaultAdapterV1 {
	using SafeERC20 for IERC20;

	constructor(
		Stablecoin _stable,
		IERC4626 _vault,
		address[5] memory _receivers,
		uint32[5] memory _weights
	) VaultAdapterV1(_stable, _vault, _receivers, _weights) {}

	function recoverAll(address token) external onlyCurator {
		IERC20(token).safeTransfer(stable.curator(), IERC20(token).balanceOf(address(this)));
	}

	function recover(address token, uint256 amount) external onlyCurator {
		IERC20(token).safeTransfer(stable.curator(), amount);
	}
}
