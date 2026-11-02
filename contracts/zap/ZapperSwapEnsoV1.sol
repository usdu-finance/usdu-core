// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {Address} from '@openzeppelin/contracts/utils/Address.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {ISwapBridgeV1} from '../swap/general/ISwapBridgeV1.sol';
import {ISwapRouterV1} from '../swap/router/ISwapRouterV1.sol';
import {ITwocrypto} from '../curve/helpers/ITwocrypto.sol';
import {ICurveStableSwapNG} from '../curve/helpers/ICurveStableSwapNG.sol';

import {IZapperSwapEnsoV1} from './IZapperSwapEnsoV1.sol';

/**
 * @title ZapperSwapEnsoV1
 * @author @samclassix <samclassix@proton.me>
 * @notice One-transaction entry into the USDU stablecoins and their reward vaults from any token. The caller
 *         (off-chain) supplies the route as an ordered list of steps: an optional call to the Enso router that
 *         turns an arbitrary token into an entry coin, followed by native hops through the swap modules, Curve
 *         pools and StreamerVaults. The contract does no routing of its own. The Enso router and the hop
 *         targets are fixed at deployment and there is no owner: a new pool, module or Enso router version
 *         means deploying a new zapper.
 *
 * @dev Security model:
 *      - Holds nothing between transactions: all funds come from `msg.sender` and every leftover is returned
 *        to them, so a step can only ever touch the caller's own funds of that transaction.
 *      - The zapper only pulls from `msg.sender`. Users approve it for their input token, and because it never
 *        takes a `from` argument, nobody can spend those approvals on someone else's behalf.
 *      - Targets are fixed in the constructor and can never change; there is no owner and no admin function.
 *        The two kinds of step are not equally powerful, so they are kept apart:
 *          * hop targets (swap routers, Curve pools, vaults) are only ever called with this contract's own,
 *            fixed function shapes and arguments (the zapper as receiver, its own balance as the amount), so
 *            they can never spend anybody else's approval. They may well be ERC-20s themselves (vault shares,
 *            Curve LP tokens), which is fine for exactly that reason.
 *          * the Enso router is the only target of `Call` steps and receives caller-supplied calldata, so it
 *            must never be a token or anything else that moves funds on behalf of `msg.sender`: a `Call` aimed
 *            at a token could `transferFrom` any user that approved the zapper. The constructor rejects a hop
 *            target equal to the Enso router, so a vault share or LP token can never become the call target.
 *      - With no owner there is no rescue either, so funds sent here by mistake are not recoverable. ETH and
 *        leftover input tokens are refunded to whoever zaps next, and a token spent with `amountIn = 0` includes
 *        any stranded balance; a stranded balance of a zap's output token is paid to its recipient, while the
 *        `minAmountOut` check only counts what the route itself delivered.
 *      - Approvals given to targets are exact and reset to zero after each step.
 *      - Outputs are measured by balance deltas, per step and overall, so a wrong route reverts instead of
 *        quietly paying out less than `minAmountOut`.
 */
contract ZapperSwapEnsoV1 is IZapperSwapEnsoV1, ReentrancyGuard {
	using SafeERC20 for IERC20;

	/// @inheritdoc IZapperSwapEnsoV1
	address public constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

	/// @inheritdoc IZapperSwapEnsoV1
	address public immutable ensoRouter;

	/// @inheritdoc IZapperSwapEnsoV1
	mapping(address => bool) public isHopTarget;

	// ---------------------------------------------------------------------------------------

	constructor(address _ensoRouter, address[] memory hopTargets) {
		if (_ensoRouter == address(0)) revert ZeroEnsoRouter();
		ensoRouter = _ensoRouter;
		emit EnsoRouterSet(_ensoRouter);

		for (uint256 i = 0; i < hopTargets.length; ++i) {
			// a hop target may be a token, so it must never also be the target of arbitrary calldata
			if (hopTargets[i] == _ensoRouter) revert HopTargetIsEnsoRouter(hopTargets[i]);
			isHopTarget[hopTargets[i]] = true;
			emit HopTargetSet(hopTargets[i]);
		}
	}

	/// @dev Enso may send ETH back (unwrapped refunds); anything left is returned to the caller.
	receive() external payable {}

	// ---------------------------------------------------------------------------------------

	/// @inheritdoc IZapperSwapEnsoV1
	function zap(
		address tokenIn,
		uint256 amountIn,
		Step[] calldata steps,
		address tokenOut,
		uint256 minAmountOut,
		address recipient
	) external payable nonReentrant returns (uint256 amountOut) {
		if (steps.length == 0) revert NoSteps();
		if (tokenIn == tokenOut) revert SameToken();
		if (recipient == address(0)) revert ZeroRecipient();

		if (tokenIn == NATIVE) {
			if (msg.value != amountIn) revert BadValue();
		} else {
			if (msg.value != 0) revert BadValue();
			IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
		}

		uint256 outBefore = _balance(tokenOut);

		for (uint256 i = 0; i < steps.length; ++i) {
			_run(i, steps[i]);
		}

		// The route must deliver at least minAmountOut itself, measured as a balance change; whatever else of the
		// output token is stranded here (sent by mistake) goes out with it rather than staying stuck
		uint256 delivered = _balance(tokenOut) - outBefore;
		if (delivered == 0 || delivered < minAmountOut) revert InsufficientOutput(delivered, minAmountOut);
		amountOut = _balance(tokenOut);
		_send(tokenOut, recipient, amountOut);

		// Whatever the route did not consume goes back to the caller
		if (tokenIn != NATIVE) {
			uint256 leftover = IERC20(tokenIn).balanceOf(address(this));
			if (leftover > 0) IERC20(tokenIn).safeTransfer(msg.sender, leftover);
		}
		if (address(this).balance > 0) _send(NATIVE, msg.sender, address(this).balance);

		emit Zap(msg.sender, recipient, tokenIn, amountIn, tokenOut, amountOut);
	}

	// ---------------------------------------------------------------------------------------

	function _run(uint256 index, Step calldata s) internal {
		// `Call` goes to the Enso router and nowhere else; every typed hop goes to an allowlisted hop target
		if (!(s.kind == Kind.Call ? s.target == ensoRouter : isHopTarget[s.target])) revert TargetNotAllowed(s.target);
		if (s.tokenIn == s.tokenOut) revert BadStep(index);

		uint256 outBefore = _balance(s.tokenOut);

		if (s.kind == Kind.Call) {
			if (s.tokenIn == NATIVE) {
				Address.functionCallWithValue(s.target, s.data, s.value);
			} else {
				IERC20 token = IERC20(s.tokenIn);
				token.forceApprove(s.target, s.amountIn == 0 ? token.balanceOf(address(this)) : s.amountIn);
				Address.functionCallWithValue(s.target, s.data, s.value);
				token.forceApprove(s.target, 0);
			}
		} else {
			// native hops always spend an ERC-20 and always receive one
			if (s.tokenIn == NATIVE || s.tokenOut == NATIVE) revert BadStep(index);

			IERC20 token = IERC20(s.tokenIn);
			uint256 amount = s.amountIn == 0 ? token.balanceOf(address(this)) : s.amountIn;
			token.forceApprove(s.target, amount);

			if (s.kind == Kind.ModuleIn) {
				ISwapRouterV1(s.target).swapInTo(ISwapBridgeV1(s.module), address(this), amount);
			} else if (s.kind == Kind.ModuleOut) {
				ISwapRouterV1(s.target).swapOutTo(ISwapBridgeV1(s.module), address(this), amount);
			} else if (s.kind == Kind.CurveStable) {
				ICurveStableSwapNG(s.target).exchange(int128(uint128(s.i)), int128(uint128(s.j)), amount, s.minOut);
			} else if (s.kind == Kind.CurveTwocrypto) {
				ITwocrypto(s.target).exchange(s.i, s.j, amount, s.minOut);
			} else if (s.kind == Kind.VaultDeposit) {
				IERC4626(s.target).deposit(amount, address(this));
			} else if (s.kind == Kind.VaultRedeem) {
				IERC4626(s.target).redeem(amount, address(this), address(this));
			} else {
				// A kind added to the enum later must get its own branch above, never fall through to a redeem
				revert BadStep(index);
			}

			token.forceApprove(s.target, 0);
		}

		uint256 got = _balance(s.tokenOut) - outBefore;
		if (got == 0 || got < s.minOut) revert InsufficientStepOutput(index, got, s.minOut);
	}

	function _balance(address token) internal view returns (uint256) {
		return token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
	}

	function _send(address token, address to, uint256 amount) internal {
		if (token == NATIVE) {
			(bool ok, ) = to.call{value: amount}('');
			if (!ok) revert NativeTransferFailed();
		} else {
			IERC20(token).safeTransfer(to, amount);
		}
	}
}
