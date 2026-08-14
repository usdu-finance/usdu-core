// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

interface IStablecoinBridge {
	function eur() external view returns (IERC20);

	function dEURO() external view returns (IERC20);

	function horizon() external view returns (uint256);

	function limit() external view returns (uint256);

	function minted() external view returns (uint256);

	function mint(uint256 amount) external;

	function mintTo(address target, uint256 amount) external;

	function burn(uint256 amount) external;

	function burnAndSend(address target, uint256 amount) external;
}
