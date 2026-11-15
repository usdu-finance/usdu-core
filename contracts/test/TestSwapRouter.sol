// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @dev Test double for an aggregator: pulls `amountIn` of `tokenIn` from the caller and pays `rate`/1e18 of
///      `tokenOut` (from its own stock) to `to`. Does not mint, so it must be funded with `tokenOut` first.
contract TestSwapRouter {
	uint256 public rate = 1e18;

	function setRate(uint256 _rate) external {
		rate = _rate;
	}

	function swap(address tokenIn, address tokenOut, uint256 amountIn, address to) external {
		IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
		IERC20(tokenOut).transfer(to, (amountIn * rate) / 1e18);
	}
}
