// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @notice The slice of StreamerVaultV1 the depositor talks to.
interface IStreamerVaultLike {
	function asset() external view returns (address);

	function totalSupply() external view returns (uint256);

	function sync() external;
}

/// @title IStreamerDepositorV1
/// @notice Surface of StreamerDepositorV1: on a fixed cadence, moves a capped percentage of the DAO's (the curator's)
///         balance of a stablecoin straight into that coin's StreamerVaultV1, callable by anyone.
interface IStreamerDepositorV1 {
	/// @param enabled Whether anyone may currently trigger deposits for this token.
	/// @param vault StreamerVaultV1 funded with this token; its `asset()` must be the token.
	/// @param bps Share of the DAO's token balance deposited per period, in basis points (100 = 1%).
	/// @param cooldown Seconds that must pass between two deposits (e.g. 1 weeks, 30 days).
	/// @param flowCap Hard cap on the amount deposited per period, in token units. The deposit is
	///        `min(balance * bps / 10_000, flowCap)`.
	/// @param lastDeposit Timestamp of the last deposit, 0 if none yet.
	/// @param totalDeposited Lifetime amount deposited through this contract for the token.
	struct Flow {
		bool enabled;
		address vault;
		uint16 bps;
		uint64 cooldown;
		uint256 flowCap;
		uint64 lastDeposit;
		uint256 totalDeposited;
	}

	event FlowSet(address indexed token, address indexed vault, uint16 bps, uint64 cooldown, uint256 flowCap);
	event FlowDisabled(address indexed token);
	/// @dev Same signature as `IModuleExpenseV1.Expense`, emitted on every deposit as
	///      `Expense(token, vault, amount, totalDeposited, daoBalanceLeft)`. Not inherited, as this contract has no
	///      single totalFunds / fundsCap to implement the rest of that interface.
	event Expense(address indexed token, address indexed to, uint256 amount, uint256 totalExpense, uint256 totalFunds);

	error BadFlow();
	error FlowNotEnabled(address token);
	error CooldownActive(uint256 validAt);
	error NothingToDeposit();

	/// @notice The flow configured for `token`.
	function getFlow(address token) external view returns (Flow memory);

	/// @notice Timestamp from which the next deposit for `token` is allowed.
	function nextDepositAt(address token) external view returns (uint256);

	/// @notice Amount a `deposit(token)` call would move right now, 0 if disabled, cooling down, the vault has no
	///         stakers, or the DAO has no balance or allowance.
	function depositable(address token) external view returns (uint256);

	/// @notice Curator: configures (or reconfigures) and enables the flow for `token`. Keeps the cooldown clock.
	function setFlow(address token, address vault, uint16 bps, uint64 cooldown, uint256 flowCap) external;

	/// @notice Curator or guardian: stops deposits for `token` instantly.
	function disableFlow(address token) external;

	/// @notice Permissionless: pulls the due amount of `token` from the DAO into its vault and syncs the stream.
	function deposit(address token) external returns (uint256 amount);
}
