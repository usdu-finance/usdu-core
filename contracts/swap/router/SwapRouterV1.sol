// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {Stablecoin} from '../../stablecoin/Stablecoin.sol';

import {ISwapBridgeV1} from '../general/ISwapBridgeV1.sol';

/**
 * @title SwapRouterV1
 * @author @samclassix <samclassix@proton.me>
 * @notice A stateless, non-custodial entrypoint for swapping through any ISwapBridgeV1 module registered on
 *         `stable`: the caller picks the module per call, so plugging in a new swap module (a new coin, a new
 *         backing venue) is just the curator registering it on the stablecoin as usual - no change or upgrade
 *         to this router is ever needed. The router never retains a balance across transactions: it only ever
 *         holds funds transiently, between pulling them from the caller and forwarding them to the module.
 */
contract SwapRouterV1 is ReentrancyGuard {
	using SafeERC20 for IERC20;
	using SafeERC20 for IERC20Metadata;

	/// @notice The stablecoin whose registered modules this router may forward calls to.
	Stablecoin public immutable stable;

	// ---------------------------------------------------------------------------------------

	event SwapIn(address indexed module, address indexed target, uint256 amountCoin, uint256 amountStable);
	event SwapOut(address indexed module, address indexed target, uint256 amountStable, uint256 amountCoin);

	// ---------------------------------------------------------------------------------------

	/// @notice Thrown when `module` is not (or is no longer) registered as a module on `stable`.
	error NotAModule(address module);

	// ---------------------------------------------------------------------------------------

	constructor(Stablecoin _stable) {
		stable = _stable;
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Convenience method for swapInTo(module, msg.sender, amount).
	function swapIn(ISwapBridgeV1 module, uint256 amount) external nonReentrant returns (uint256) {
		return _swapIn(module, msg.sender, amount);
	}

	/// @notice Swaps `amount` of `module`'s coin into stablecoin via `module`, minted to `target` minus its
	///         swap-in fee.
	/// @dev The caller must have approved this router to pull `amount` of `module`'s coin beforehand.
	function swapInTo(ISwapBridgeV1 module, address target, uint256 amount) external nonReentrant returns (uint256) {
		return _swapIn(module, target, amount);
	}

	function _swapIn(ISwapBridgeV1 module, address target, uint256 amount) internal returns (uint256) {
		_verifyModule(module);

		IERC20Metadata coin = module.coin();
		coin.safeTransferFrom(msg.sender, address(this), amount);
		coin.forceApprove(address(module), amount);

		uint256 amountStable = module.swapInTo(target, amount);
		emit SwapIn(address(module), target, amount, amountStable);
		return amountStable;
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Convenience method for swapOutTo(module, msg.sender, amount).
	function swapOut(ISwapBridgeV1 module, uint256 amount) external nonReentrant returns (uint256) {
		return _swapOut(module, msg.sender, amount);
	}

	/// @notice Burns `amount` of stablecoin from the caller and sends the equivalent coin, minus `module`'s
	///         swap-out fee, to `target`.
	function swapOutTo(ISwapBridgeV1 module, address target, uint256 amount) external nonReentrant returns (uint256) {
		return _swapOut(module, target, amount);
	}

	function _swapOut(ISwapBridgeV1 module, address target, uint256 amount) internal returns (uint256) {
		_verifyModule(module);

		IERC20(address(stable)).safeTransferFrom(msg.sender, address(this), amount);

		uint256 amountCoin = module.swapOutTo(target, amount);
		emit SwapOut(address(module), target, amount, amountCoin);
		return amountCoin;
	}

	// ---------------------------------------------------------------------------------------

	/// @dev Allows any module ever registered on `stable`, not just currently-valid (non-expired) ones, so
	///      swapOut can keep routing to an expired module - matching that module's own swapOut, which is
	///      designed to keep working after expiry since its fee is taken in coin rather than minted.
	function _verifyModule(ISwapBridgeV1 module) internal view {
		if (!stable.checkModule(address(module))) revert NotAModule(address(module));
	}
}
