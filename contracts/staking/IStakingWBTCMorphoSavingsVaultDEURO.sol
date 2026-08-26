// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';
import {ISwapRouter} from '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';

import {IMorpho, MarketParams, Id} from '../morpho/helpers/IMorpho.sol';
import {AutomationCompatibleInterface} from '../automation/helpers/AutomationCompatibleInterface.sol';
import {IStablecoinBridge} from './helpers/IStablecoinBridge.sol';
import {ISavingsVault} from './helpers/ISavingsVault.sol';

interface IStakingWBTCMorphoSavingsVaultDEURO is IERC4626, AutomationCompatibleInterface {
	/// @notice The rebalance action checkUpkeep/performUpkeep would take (or just took).
	enum Action {
		NONE,
		LEVERAGE, // LTV is below targetLtv - targetBand: borrow more EURC, deposit it into savingsVault
		DELEVERAGE // LTV is above targetLtv + targetBand: redeem from savingsVault, repay Morpho debt
	}

	/// @notice Grouped into a single struct (rather than ~12 constructor params) to sidestep a "stack too
	///         deep" limitation of the Solidity compiler without the (project-wide) `viaIR` build mode.
	struct ConstructorParams {
		address owner;
		IERC20 wbtc;
		IMorpho morpho;
		MarketParams market;
		IStablecoinBridge bridge;
		ISavingsVault savingsVault;
		ISwapRouter uniswapRouter;
		uint256 targetLtv;
		uint256 targetBand;
		uint256 reconcileThreshold;
		string name;
		string symbol;
	}

	// ---------------------------------------------------------------------------------------

	event Levered(uint256 borrowedEurc, uint256 investedDeuro);
	event Delevered(uint256 repaidEurc, uint256 withdrawnDeuro);
	event Reconciled(uint256 borrowedEurc, uint256 boughtWbtc);
	event Rebalanced(Action action);
	event TargetLtvChanged(uint256 previousLtv, uint256 newLtv);
	event TargetBandChanged(uint256 previousBand, uint256 newBand);
	event SwapSlippageChanged(uint256 previousSlippagePPM, uint256 newSlippagePPM);
	event ReconcileThresholdChanged(uint256 previousThreshold, uint256 newThreshold);
	event ReconcileIntervalChanged(uint256 previousInterval, uint256 newInterval);

	// ---------------------------------------------------------------------------------------

	error LtvOutOfBounds(uint256 targetLtv, uint256 targetBand, uint256 lltv);
	error SlippageTooHigh(uint256 requested, uint256 cap);
	error InvalidMarket();
	error ReconcileNotDue(uint256 delta, uint256 threshold, uint256 validAt);
	error InvalidSwapPath();

	// ---------------------------------------------------------------------------------------

	function morpho() external view returns (IMorpho);

	function marketId() external view returns (Id);

	function bridge() external view returns (IStablecoinBridge);

	function savingsVault() external view returns (ISavingsVault);

	/// @notice The fixed Uniswap V3 router `reconcile` swaps EURC for WBTC through. Only the swap path is
	///         a caller-supplied input; the router address itself is immutable, and amountIn/
	///         amountOutMinimum/recipient/deadline are all computed on-chain, never caller-supplied.
	function uniswapRouter() external view returns (ISwapRouter);

	function targetLtv() external view returns (uint256);

	function targetBand() external view returns (uint256);

	function swapSlippagePPM() external view returns (uint256);

	/// @notice Minimum EURC-denominated delta (savingsVault value above Morpho debt) worth reconciling.
	function reconcileThreshold() external view returns (uint256);

	/// @notice Minimum time between two `reconcile` calls.
	function reconcileInterval() external view returns (uint256);

	function lastReconciledAt() external view returns (uint256);

	/// @notice Borrows the current EURC surplus (savingsVault value above Morpho debt) and swaps it for
	///         WBTC through `uniswapRouter`, supplying the proceeds as additional collateral. Leaves the
	///         existing savingsVault position untouched so it keeps compounding. Permissionless, but
	///         gated by `reconcileThreshold`/`reconcileInterval` so it can't be spammed on dust.
	/// @param path Uniswap V3 encoded swap path passed to `uniswapRouter.exactInput` (tightly packed
	///        `token, fee, token, fee, ..., token`), from EURC to WBTC (the first token must be the loan
	///        token, the last token must be `asset()`). This is the only caller-supplied input — amountIn
	///        is exactly the surplus, and amountOutMinimum is enforced on-chain from the Morpho oracle
	///        price and `swapSlippagePPM`, so a bad path just reverts or fails that check; it can never
	///        drain more than the surplus being reconciled.
	function reconcile(bytes calldata path) external;

	function setTargetLtv(uint256 newTargetLtv) external;

	function setTargetBand(uint256 newTargetBand) external;

	function setSwapSlippagePPM(uint256 newSlippagePPM) external;

	function setReconcileThreshold(uint256 newThreshold) external;

	function setReconcileInterval(uint256 newInterval) external;
}
