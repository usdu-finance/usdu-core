// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/// @dev Test token with configurable decimals.
contract TestTokenDecimals is ERC20 {
	uint8 private immutable _decimals;

	constructor(string memory _name, string memory _symbol, uint8 decimals_) ERC20(_name, _symbol) {
		_decimals = decimals_;
	}

	function mint(uint256 amount) external {
		_mint(msg.sender, amount);
	}

	function decimals() public view override returns (uint8) {
		return _decimals;
	}
}

/// @dev Test token that burns 1% of every transfer, to check that fee-on-transfer collateral is rejected.
contract TestTokenFeeOnTransfer is ERC20 {
	constructor(string memory _name, string memory _symbol) ERC20(_name, _symbol) {}

	function mint(uint256 amount) external {
		_mint(msg.sender, amount);
	}

	function _update(address from, address to, uint256 value) internal override {
		if (from != address(0) && to != address(0)) {
			uint256 fee = value / 100;
			super._update(from, address(0), fee);
			value -= fee;
		}
		super._update(from, to, value);
	}
}
