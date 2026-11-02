// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @title IZapperSwapEnsoV1
/// @notice Surface of ZapperSwapEnsoV1: pays in any token (or ETH), runs an ordered list of swap steps built off-chain,
///         and delivers the output token to a recipient in one transaction.
interface IZapperSwapEnsoV1 {
	/// @dev What a step does. All kinds spend `tokenIn` and are measured by the balance change of `tokenOut`.
	enum Kind {
		/// @dev Opaque call to the Enso router (`target` must be `ensoRouter`): `data` is sent with `value` ETH.
		Call,
		/// @dev SwapRouterV1(target).swapInTo(module, this, amount): coin -> stablecoin through a swap module.
		ModuleIn,
		/// @dev SwapRouterV1(target).swapOutTo(module, this, amount): stablecoin -> coin through a swap module.
		ModuleOut,
		/// @dev Curve StableSwap NG pool `target`: exchange(int128 i, int128 j, amount, minOut).
		CurveStable,
		/// @dev Curve Twocrypto NG pool `target`: exchange(uint256 i, uint256 j, amount, minOut).
		CurveTwocrypto,
		/// @dev ERC-4626 vault `target`: deposit(amount, this), e.g. a StreamerVaultV1 stake.
		VaultDeposit,
		/// @dev ERC-4626 vault `target`: redeem(amount, this, this), e.g. a StreamerVaultV1 unstake.
		VaultRedeem
	}

	/// @param kind What to do.
	/// @param target Contract to call: `ensoRouter` for `Call`, otherwise an allowlisted swap router, Curve pool or vault.
	/// @param module Module passed to the swap router (ModuleIn / ModuleOut only).
	/// @param tokenIn Token spent by the step; the native sentinel is only valid for `Call`.
	/// @param tokenOut Token received by the step; the native sentinel is only valid for `Call`.
	/// @param amountIn Amount of `tokenIn` to spend, or 0 for the zapper's entire balance of it, which is what
	///        every step after the first should use since the previous output is only known at execution time.
	/// @param minOut Revert unless the step delivers at least this much `tokenOut`.
	/// @param i Curve index of `tokenIn` (Curve kinds only).
	/// @param j Curve index of `tokenOut` (Curve kinds only).
	/// @param value ETH sent along with the call (`Call` only).
	/// @param data Calldata for `target` (`Call` only). Must pay `tokenOut` to the zapper itself.
	struct Step {
		Kind kind;
		address target;
		address module;
		address tokenIn;
		address tokenOut;
		uint256 amountIn;
		uint256 minOut;
		uint8 i;
		uint8 j;
		uint256 value;
		bytes data;
	}

	event Zap(
		address indexed sender,
		address indexed recipient,
		address tokenIn,
		uint256 amountIn,
		address tokenOut,
		uint256 amountOut
	);
	event EnsoRouterSet(address indexed router);
	/// @dev Emitted once per hop target by the constructor, so indexers can read the allowlist.
	event HopTargetSet(address indexed target);

	error NoSteps();
	error SameToken();
	error ZeroRecipient();
	error BadValue();
	error BadStep(uint256 index);
	error TargetNotAllowed(address target);
	error ZeroEnsoRouter();
	error HopTargetIsEnsoRouter(address target);
	error InsufficientStepOutput(uint256 index, uint256 got, uint256 required);
	error InsufficientOutput(uint256 got, uint256 required);
	error NativeTransferFailed();

	/// @notice Sentinel for ETH, matching the one aggregators such as Enso use.
	function NATIVE() external view returns (address);

	/// @notice The Enso router, the only target `Call` steps may use. Fixed at deployment and never a hop target.
	function ensoRouter() external view returns (address);

	/// @notice Whether `target` may be used by a typed step (swap router, Curve pool, vault). Fixed at deployment.
	function isHopTarget(address target) external view returns (bool);

	/// @notice Pulls `amountIn` of `tokenIn` (or takes `msg.value` for ETH), runs `steps` in order and sends the
	///         resulting `tokenOut` to `recipient`. Leftover `tokenIn` and ETH are returned to the caller. Reverts
	///         if `tokenOut` ends up below `minAmountOut`, or any step delivers nothing or less than its `minOut`.
	/// @dev The caller must have approved this contract for `amountIn` of `tokenIn` beforehand. The zapper only
	///      ever pulls from `msg.sender`, so approvals to it cannot be spent by anyone else.
	function zap(
		address tokenIn,
		uint256 amountIn,
		Step[] calldata steps,
		address tokenOut,
		uint256 minAmountOut,
		address recipient
	) external payable returns (uint256 amountOut);
}
