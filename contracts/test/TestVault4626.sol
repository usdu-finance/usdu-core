// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {ERC4626} from '@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @dev Minimal ERC4626 vault for tests. Transferring `asset` directly to this contract simulates yield accrual,
///      since totalAssets() defaults to the vault's own asset balance.
contract TestVault4626 is ERC4626 {
	constructor(IERC20 _asset) ERC20('Test Vault', 'tVLT') ERC4626(_asset) {}
}
