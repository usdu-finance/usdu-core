// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IStablecoinModifier, IStablecoinMetadata} from '../stablecoin/IStablecoinModifier.sol';

import {IStreamerDepositorV1, IStreamerVaultLike} from './IStreamerDepositorV1.sol';

/**
 * @title StreamerDepositorV1
 * @author @samclassix <integration@usdu.finance>
 * @notice Funds the StreamerVaultV1 reward vaults straight from the DAO's wallet, without the DAO acting each
 *         time. The DAO (the stablecoin's curator) approves this contract for the native stablecoins (USDU, CHFU,
 *         EURU) and configures one flow per token: target vault, a percentage of its balance, a cooldown and a
 *         flow cap. From then on anyone may call `deposit(token)` once per cooldown, which moves
 *         `min(balance * bps / 10_000, flowCap)` from the DAO into the vault and calls `sync()` on it, so the
 *         amount starts streaming to the stakers right away.
 *
 * @dev Security model:
 *      - Funds move only DAO -> vault inside one transaction; the contract never holds tokens. The caller only
 *        chooses *when* a deposit happens (at most once per cooldown), never how much or where to.
 *      - The percentage makes the flow follow the DAO's balance (it shrinks as the treasury shrinks); the flow cap
 *        bounds it when the treasury is large, so a period can never spend more than `flowCap`. The DAO's ERC-20
 *        allowance is a further hard ceiling, and the amount is clamped to it.
 *      - The DAO is `stable.curator()` resolved at call time, so a curator change moves the source (and requires the
 *        new curator to approve) without any action here.
 *      - The vault must report the token as its `asset()`; this is checked when the flow is set.
 *      - Nothing is deposited while the vault has no stakers: StreamerVaultV1 would leave the amount unsynced, so
 *        the cooldown is not burned for nothing.
 *      - Lateness is not made up: a deposit resets the cooldown to the time of the call, the cap applies per call.
 *      - The guardian may disable a flow instantly; only the curator can (re)set one.
 */
contract StreamerDepositorV1 is IStreamerDepositorV1, IStablecoinModifier, ReentrancyGuard {
	using SafeERC20 for IERC20;

	uint256 public constant BPS_SCALE = 10_000;

	mapping(address => Flow) internal _flows;

	// ---------------------------------------------------------------------------------------

	constructor(IStablecoinMetadata _stable) IStablecoinModifier(_stable) {}

	// ---------------------------------------------------------------------------------------

	/// @inheritdoc IStreamerDepositorV1
	function getFlow(address token) external view returns (Flow memory) {
		return _flows[token];
	}

	/// @inheritdoc IStreamerDepositorV1
	function nextDepositAt(address token) public view returns (uint256) {
		Flow storage f = _flows[token];
		return f.lastDeposit == 0 ? 0 : uint256(f.lastDeposit) + f.cooldown;
	}

	/// @inheritdoc IStreamerDepositorV1
	function depositable(address token) public view returns (uint256) {
		Flow storage f = _flows[token];
		if (!f.enabled || block.timestamp < nextDepositAt(token)) return 0;
		if (IStreamerVaultLike(f.vault).totalSupply() == 0) return 0;

		address dao = stable.curator();
		uint256 balance = IERC20(token).balanceOf(dao);
		uint256 amount = (balance * f.bps) / BPS_SCALE;
		if (amount > f.flowCap) amount = f.flowCap;

		uint256 allowed = IERC20(token).allowance(dao, address(this));
		return amount < allowed ? amount : allowed;
	}

	// ---------------------------------------------------------------------------------------

	/// @inheritdoc IStreamerDepositorV1
	function setFlow(address token, address vault, uint16 bps, uint64 cooldown, uint256 flowCap) external onlyCurator {
		if (token == address(0) || vault == address(0) || bps == 0 || bps > BPS_SCALE || cooldown == 0 || flowCap == 0) revert BadFlow();
		if (IStreamerVaultLike(vault).asset() != token) revert BadFlow();

		Flow storage f = _flows[token];
		f.enabled = true;
		f.vault = vault;
		f.bps = bps;
		f.cooldown = cooldown;
		f.flowCap = flowCap;

		emit FlowSet(token, vault, bps, cooldown, flowCap);
	}

	/// @inheritdoc IStreamerDepositorV1
	function disableFlow(address token) external onlyCuratorOrGuardian {
		_flows[token].enabled = false;
		emit FlowDisabled(token);
	}

	// ---------------------------------------------------------------------------------------

	/// @inheritdoc IStreamerDepositorV1
	function deposit(address token) external nonReentrant returns (uint256 amount) {
		Flow storage f = _flows[token];
		if (!f.enabled) revert FlowNotEnabled(token);

		uint256 validAt = nextDepositAt(token);
		if (block.timestamp < validAt) revert CooldownActive(validAt);

		amount = depositable(token);
		if (amount == 0) revert NothingToDeposit();

		address dao = stable.curator();
		address vault = f.vault;

		f.lastDeposit = uint64(block.timestamp);
		f.totalDeposited += amount;

		IERC20(token).safeTransferFrom(dao, vault, amount);
		IStreamerVaultLike(vault).sync();

		emit Expense(token, vault, amount, f.totalDeposited, IERC20(token).balanceOf(dao));
	}
}
