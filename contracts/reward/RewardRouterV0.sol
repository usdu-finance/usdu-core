// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IStablecoin} from '../stablecoin/IStablecoin.sol';

/// @title RewardRouterV0 - Non-custodial Router
/// @author @samclassix <samclassix@proton.me>
/// @notice This contract acts purely as a non-custodial router, helping connect on-chain deposits with the off-chain reward program.
contract RewardRouterV0 {
	using Math for uint256;
	using SafeERC20 for IERC20;

	// stable
	IStablecoin public immutable stable;

	// UniversalRewardsDistributor
	address public immutable urd;

	// signer -> token -> approved
	mapping(address => mapping(address => uint256)) public approved;

	// events
	event SetApprove(address indexed signer, address indexed token, uint256 amount);
	event Rewards(address indexed signer, address indexed token, uint256 amount);

	// errors

	error AllowanceTooLow();

	// ---------------------------------------------------------------------------------------

	constructor(IStablecoin _stable, address _urd) {
		stable = _stable;
		urd = _urd;
	}

	// ---------------------------------------------------------------------------------------

	function setApprove(address signer, address token, uint256 amount) external {
		stable.verifyCurator(msg.sender);
		approved[signer][token] = amount;
		emit SetApprove(signer, token, amount);
	}

	// ---------------------------------------------------------------------------------------

	/// @dev This is a work around, since a signature is needed for the program.
	// The contract immediately forwards the tokens to urd, avoiding custody.
	/// @param token The token contract address
	/// @param amount The amount to deposit
	function deposit(address signer, address token, uint256 amount) external {
		if (approved[signer][token] < amount) revert AllowanceTooLow();
		approved[signer][token] -= amount;
		IERC20(token).transfer(signer, amount);
		IERC20(token).transferFrom(signer, urd, amount);
		emit Rewards(signer, token, amount);
	}
}
