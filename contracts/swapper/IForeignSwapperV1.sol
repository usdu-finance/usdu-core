// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @title IForeignSwapperV1
/// @notice Surface of ForeignSwapperV1: converts "foreign" tokens held by the DAO (the curator) into ecosystem
///         tokens along a route the curator configured, callable by anyone.
interface IForeignSwapperV1 {
	/// @param target Contract called by this step (aggregator, router, pool, vault, ...). The foreign token itself only for an ERC-4626 redeem/withdraw (unwrapping a share).
	/// @param tokenIn Token spent by the step. The swapper approves `target` for its whole balance of it, for the
	///        duration of the call only.
	/// @param tokenOut Token received by the step; must be the `tokenIn` of the next step, or the route's `tokenOut`.
	/// @param patchAmount If true, the swapper's balance of `tokenIn` is written as a 32-byte word into `data` at
	///        `amountOffset` right before the call, so a payload built off-chain with a dummy amount still spends
	///        exactly what the previous step delivered.
	/// @param amountOffset Byte offset into `data` (selector included) of the amount word.
	/// @param data Calldata for `target`. It must pay `tokenOut` to the swapper itself.
	struct Step {
		address target;
		address tokenIn;
		address tokenOut;
		bool patchAmount;
		uint16 amountOffset;
		bytes data;
	}

	/// @param enabled Whether anyone may currently run this route.
	/// @param tokenOut Ecosystem token the route ends in (e.g. USDU).
	/// @param minRate Minimum `tokenOut` per `tokenIn` actually spent, 1e18-scaled and in raw units (so decimals
	///        differences must be baked in): the route reverts if `delivered < spent * minRate / 1e18`.
	/// @param maxAmount Cap on `tokenIn` per call, 0 for none. Bounds what a single call exposes to the route.
	/// @param minAmount Smallest `tokenIn` amount worth converting, so dust calls cannot spam the route.
	/// @param steps Ordered, chained steps: `steps[0].tokenIn` is the foreign token, the last `tokenOut` is `tokenOut`.
	struct Route {
		bool enabled;
		address tokenOut;
		uint256 minRate;
		uint256 maxAmount;
		uint256 minAmount;
		Step[] steps;
	}

	event RouteSet(address indexed token, address indexed tokenOut, uint256 minRate, uint256 maxAmount, uint256 minAmount);
	event RouteDisabled(address indexed token);
	/// @dev `spent` of the foreign `token` was converted into `received` of `tokenOut`, both swept to `dao`.
	event Swapped(
		address indexed caller,
		address indexed dao,
		address indexed token,
		address tokenOut,
		uint256 spent,
		uint256 received
	);

	error RouteNotEnabled(address token);
	error BadRoute();
	error NothingToSwap();
	error InsufficientOutput(uint256 got, uint256 required);

	/// @notice The route configured for foreign `token`.
	function getRoute(address token) external view returns (Route memory);

	/// @notice Amount of `token` that `swap(token)` would pull from the DAO right now.
	function swappable(address token) external view returns (uint256);

	/// @notice Curator only: sets (and enables) the route for foreign `token`, replacing any previous one.
	function setRoute(address token, Route calldata route) external;

	/// @notice Curator or guardian: stops `swap(token)` until the curator sets a route again.
	function disableRoute(address token) external;

	/// @notice Permissionless: pulls the DAO's balance of `token` (bounded by its allowance and the route cap), runs
	///         the route and sweeps `token` leftovers, `tokenOut` and any intermediate balances to the DAO.
	function swap(address token) external returns (uint256 spent, uint256 received);
}
