// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {Address} from '@openzeppelin/contracts/utils/Address.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IStablecoinModifier, IStablecoinMetadata} from '../stablecoin/IStablecoinModifier.sol';

import {IForeignSwapperV1} from './IForeignSwapperV1.sol';

/**
 * @title ForeignSwapperV1
 * @author @samclassix <samclassix@proton.me>
 * @notice Turns "foreign" tokens held by the DAO (USDT, USDC, ZCHF, dEURO, ...) into ecosystem tokens without the
 *         DAO having to act each time. The DAO (the stablecoin's curator) approves this contract for a foreign
 *         token and configures a route for it; from then on anyone may call `swap(token)`, which pulls the DAO's
 *         balance, runs the configured route, and sweeps the foreign leftovers, the target token and every
 *         intermediate balance back to the DAO in the same transaction.
 *
 * @dev Security model:
 *      - Funds move only DAO -> swapper -> route -> DAO inside one transaction; the contract holds nothing between
 *        transactions and the caller only chooses *when* a swap happens, never *how*. All routing is curator
 *        config, so a caller cannot redirect value, only pay gas for the DAO's conversion.
 *      - The DAO is `stable.curator()` resolved at call time, so a curator change moves the sweep destination
 *        (and requires the new curator to approve) without any action here.
 *      - Price protection is a curator-set floor, `minRate`, on what the route delivered per unit spent. There is
 *        no oracle: the curator keeps the floor tight and refreshes it, and `maxAmount` bounds exposure per call.
 *        Anyone can sandwich a swap, but only down to that floor.
 *      - Route steps are arbitrary calldata to curator-chosen targets, so the curator is fully trusted (it already
 *        controls the DAO's funds). Defence in depth: a step can never target the swapper or the stablecoin, and
 *        only target the foreign token itself to unwrap a vault share (ERC-4626 redeem / withdraw), steps must chain token to token, and approvals are exact and reset after each step.
 *      - The guardian may disable a route instantly; only the curator can (re)set one.
 */
contract ForeignSwapperV1 is IForeignSwapperV1, IStablecoinModifier, ReentrancyGuard {
	using SafeERC20 for IERC20;

	uint256 public constant RATE_SCALE = 1e18;

	mapping(address => Route) internal _routes;

	// ---------------------------------------------------------------------------------------

	constructor(IStablecoinMetadata _stable) IStablecoinModifier(_stable) {}

	// ---------------------------------------------------------------------------------------

	/// @inheritdoc IForeignSwapperV1
	function getRoute(address token) external view returns (Route memory) {
		return _routes[token];
	}

	/// @inheritdoc IForeignSwapperV1
	function swappable(address token) public view returns (uint256) {
		Route storage r = _routes[token];
		if (!r.enabled) return 0;

		address dao = stable.curator();
		uint256 amount = IERC20(token).balanceOf(dao);
		uint256 allowed = IERC20(token).allowance(dao, address(this));
		if (allowed < amount) amount = allowed;
		if (r.maxAmount != 0 && r.maxAmount < amount) amount = r.maxAmount;
		return amount < r.minAmount ? 0 : amount;
	}

	// ---------------------------------------------------------------------------------------

	/// @inheritdoc IForeignSwapperV1
	function setRoute(address token, Route calldata route) external onlyCurator {
		uint256 n = route.steps.length;
		if (n == 0 || n > 8 || token == route.tokenOut || route.tokenOut == address(0) || route.minRate == 0) revert BadRoute();
		if (route.steps[0].tokenIn != token || route.steps[n - 1].tokenOut != route.tokenOut) revert BadRoute();

		for (uint256 i = 0; i < n; ++i) {
			Step calldata s = route.steps[i];
			// the target gets an exact approval and calldata: it must never be able to touch the DAO's approvals
			if (s.target == address(this) || s.target == address(stable)) revert BadRoute();
			// the one legitimate call into the foreign token itself is unwrapping a vault share (ERC-4626)
			if (s.target == token && !_isUnwrap(s.data)) revert BadRoute();
			if (s.tokenIn == s.tokenOut || s.tokenIn == address(0) || s.tokenOut == address(0)) revert BadRoute();
			if (i > 0 && s.tokenIn != route.steps[i - 1].tokenOut) revert BadRoute();
			if (s.patchAmount && uint256(s.amountOffset) + 32 > s.data.length) revert BadRoute();
		}

		Route storage r = _routes[token];
		r.enabled = true;
		r.tokenOut = route.tokenOut;
		r.minRate = route.minRate;
		r.maxAmount = route.maxAmount;
		r.minAmount = route.minAmount;
		delete r.steps;
		for (uint256 i = 0; i < n; ++i) r.steps.push(route.steps[i]);

		emit RouteSet(token, route.tokenOut, route.minRate, route.maxAmount, route.minAmount);
	}

	/// @inheritdoc IForeignSwapperV1
	function disableRoute(address token) external onlyCuratorOrGuardian {
		_routes[token].enabled = false;
		emit RouteDisabled(token);
	}

	// ---------------------------------------------------------------------------------------

	/// @inheritdoc IForeignSwapperV1
	function swap(address token) external nonReentrant returns (uint256 spent, uint256 received) {
		Route storage r = _routes[token];
		if (!r.enabled) revert RouteNotEnabled(token);

		uint256 amount = swappable(token);
		if (amount == 0) revert NothingToSwap();

		address dao = stable.curator();
		address tokenOut = r.tokenOut;
		uint256 tokenBefore = IERC20(token).balanceOf(address(this));
		uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));

		IERC20(token).safeTransferFrom(dao, address(this), amount);

		for (uint256 i = 0; i < r.steps.length; ++i) {
			_run(r.steps[i]);
		}

		// measured as balance changes, so stranded balances neither help nor hurt the check
		uint256 tokenAfter = IERC20(token).balanceOf(address(this));
		spent = tokenBefore + amount > tokenAfter ? tokenBefore + amount - tokenAfter : 0;
		uint256 outAfter = IERC20(tokenOut).balanceOf(address(this));
		received = outAfter > outBefore ? outAfter - outBefore : 0;

		uint256 required = (spent * r.minRate) / RATE_SCALE;
		if (spent == 0 || received == 0 || received < required) revert InsufficientOutput(received, required);

		_sweepAll(r, token, dao);

		emit Swapped(msg.sender, dao, token, tokenOut, spent, received);
	}

	// ---------------------------------------------------------------------------------------

	/// @dev Everything goes to the DAO: leftover foreign token, the target token, and any intermediate balance.
	function _sweepAll(Route storage r, address token, address dao) internal {
		_sweep(token, dao);
		_sweep(r.tokenOut, dao);
		for (uint256 i = 0; i < r.steps.length; ++i) {
			_sweep(r.steps[i].tokenIn, dao);
			_sweep(r.steps[i].tokenOut, dao);
		}
	}

	/// @dev ERC-4626 redeem(uint256,address,address) / withdraw(uint256,address,address) only. The shares are burned
	///      from the swapper itself (owner = msg.sender), so nothing here can spend the DAO's approval.
	function _isUnwrap(bytes calldata data) internal pure returns (bool) {
		if (data.length < 100) return false;
		bytes4 sel = bytes4(data[:4]);
		return sel == 0xba087652 || sel == 0xb460af94;
	}

	function _run(Step memory s) internal {
		IERC20 tokenIn = IERC20(s.tokenIn);
		uint256 amount = tokenIn.balanceOf(address(this));

		if (s.patchAmount) {
			uint256 offset = s.amountOffset;
			assembly {
				mstore(add(add(mload(add(s, 0xa0)), 0x20), offset), amount)
			}
		}

		tokenIn.forceApprove(s.target, amount);
		Address.functionCall(s.target, s.data);
		tokenIn.forceApprove(s.target, 0);
	}

	function _sweep(address token, address to) internal {
		uint256 bal = IERC20(token).balanceOf(address(this));
		if (bal > 0) IERC20(token).safeTransfer(to, bal);
	}
}
