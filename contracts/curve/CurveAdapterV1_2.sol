// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {Context} from '@openzeppelin/contracts/utils/Context.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {RewardDistributionV1, Stablecoin} from '../reward/RewardDistributionV1.sol';

import {ICurveStableSwapNG} from './helpers/ICurveStableSwapNG.sol';

/**
 * @title CurveAdapterV1_2
 * @author @samclassix <samclassix@proton.me>
 * @notice Enhanced Curve StableSwapNG adapter enabling dual-sided liquidity provision with automated profit reconciliation.
 *         Maintains simple accounting (Assets = LP value via virtual price, Liabilities = totalMinted) while providing
 *         protocol-level profit tracking and distribution capabilities.
 *
 * @dev Key Features:
 *      - Dual-token liquidity addition (User provides coin, adapter mints stablecoin)
 *      - Imbalance-protected operations (only when pool conditions are favorable)
 *      - Virtual price-based asset valuation for accurate LP token accounting
 *      - Independent profit reconciliation via mint-and-distribute mechanism
 *      - Emergency controls with debt coverage capabilities
 */
contract CurveAdapterV1_2 is RewardDistributionV1 {
	using Math for uint256;
	using SafeERC20 for IERC20Metadata;
	using SafeERC20 for Stablecoin;

	/// @notice The Curve StableSwapNG pool this adapter interfaces with
	ICurveStableSwapNG public immutable pool;

	/// @notice The external token (e.g., USDC) that users deposit
	IERC20Metadata public immutable coin;

	/// @notice Index of the stablecoin (USDU) in the pool (0 or 1)
	uint256 public immutable idxS;

	/// @notice Index of the external coin (USDC) in the pool (0 or 1)
	uint256 public immutable idxC;

	/// @notice Total amount of stablecoins minted by this adapter (protocol liabilities)
	uint256 public totalMinted;

	/// @notice Cumulative revenue generated and distributed by the adapter
	uint256 public totalRevenue;

	/// @notice Block number of the last reconcile operation
	/// @dev Enforces a 50,000 block cooldown (~7 days) between reconcile operations to prevent profit manipulation
	uint256 public latestReconcile = 0;

	/// @notice Maximum allowed imbalance deviation (e.g., 0.2 ether = 20%)
	/// @dev When pool imbalance is below this threshold, adapter operations are blocked to allow free market
	uint256 public maxImbalanceThreshold = 0.2 ether;

	// ---------------------------------------------------------------------------------------
	// EVENTS
	// ---------------------------------------------------------------------------------------

	/// @notice Emitted when a user adds liquidity through the adapter
	/// @param sender The user who added liquidity
	/// @param minted Amount of stablecoins minted for the operation
	/// @param totalMinted New total of minted stablecoins
	/// @param sharesMinted LP tokens received by the user
	/// @param totalShares Total LP tokens held by the adapter
	event AddLiquidity(address indexed sender, uint256 minted, uint256 totalMinted, uint256 sharesMinted, uint256 totalShares);

	/// @notice Emitted when a user removes liquidity through the adapter
	/// @param sender The user who removed liquidity
	/// @param burned Amount of debt burned during the operation
	/// @param totalMinted New total of minted stablecoins
	/// @param sharesBurned LP tokens used in the operation
	/// @param totalShares Total LP tokens remaining with the adapter
	event RemoveLiquidity(address indexed sender, uint256 burned, uint256 totalMinted, uint256 sharesBurned, uint256 totalShares);

	/// @notice Emitted when protocol revenue is generated and distributed
	/// @param amount Amount of revenue generated in this operation
	/// @param totalRevenue New cumulative total revenue
	/// @param totalMinted Total minted after revenue reconciliation
	event Revenue(uint256 amount, uint256 totalRevenue, uint256 totalMinted);

	// ---------------------------------------------------------------------------------------
	// CUSTOM ERRORS
	// ---------------------------------------------------------------------------------------

	/// @notice Thrown when pool imbalance state doesn't match operation requirements
	/// @param balances Current pool balances [stablecoin, coin]
	error ImbalancedVariant(uint256[] balances);

	/// @notice Thrown when a liquidity removal operation would not be profitable
	/// @param given Actual USDU balance available
	/// @param minimum Required USDU amount to cover debt
	error NotProfitable(uint256 given, uint256 minimum);

	/// @notice Thrown when attempting operations with zero amounts
	error ZeroAmount();

	/// @notice Thrown when reconciliation is called but no profit exists to distribute
	/// @param assets Current adapter assets (LP value)
	/// @param minted Current adapter liabilities (minted debt)
	error NothingToReconcile(uint256 assets, uint256 minted);

	/// @notice Thrown when attempting reconcile operation before the 50,000 block cooldown period expires
	error ReconcileGuardError();

	/// @notice Thrown when pool imbalance is within threshold and adapter operations are blocked
	/// @param currentDeviation Current pool imbalance deviation
	/// @param maxAllowed Maximum allowed deviation threshold
	error ImbalanceWithinThreshold(uint256 currentDeviation, uint256 maxAllowed);

	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Enforces a 50,000 block cooldown period between reconcile operations
	 * @dev Economic protection mechanism that:
	 *      - Prevents frequent reconciliation that could drain profits prematurely
	 *      - Allows sufficient time for meaningful LP fee accumulation (~7 days at 12s blocks)
	 *      - Reduces gas costs by batching profit recognition over longer periods
	 *      - Protects against automated profit extraction strategies
	 *      - Ensures reconciliation happens at economically meaningful intervals
	 */
	modifier ReconcileGuard() {
		if (latestReconcile + 50000 > block.number) revert ReconcileGuardError();
		latestReconcile = block.number;
		_;
	}

	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Initializes the CurveAdapterV1_2 with pool configuration and revenue distribution setup
	 * @param _pool The Curve StableSwapNG pool address to interface with
	 * @param _idxS Index of the stablecoin in the pool (must be 0 or 1)
	 * @param _idxC Index of the external coin in the pool (must be 0 or 1)
	 * @param _receivers Array of addresses to receive distributed profits (up to 5)
	 * @param _weights Corresponding weights for profit distribution (proportional splits)
	 */
	constructor(
		ICurveStableSwapNG _pool,
		uint256 _idxS,
		uint256 _idxC,
		address[5] memory _receivers,
		uint32[5] memory _weights
	) RewardDistributionV1(Stablecoin(_pool.coins(_idxS)), _receivers, _weights) {
		pool = _pool;

		require(_idxS < 2, 'idxS out of bounds for max 2 tokens');
		require(_idxC < 2, 'idxC out of bounds for max 2 tokens');

		idxS = _idxS;
		idxC = _idxC;

		coin = IERC20Metadata(_pool.coins(_idxC));
	}

	// ---------------------------------------------------------------------------------------
	// CONFIGURATION
	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Updates the maximum imbalance threshold for adapter operations
	 * @param threshold New threshold value (e.g., 0.2 ether = 20%)
	 * @dev Only curator can adjust this parameter to control when adapter intervenes in market
	 */
	function setMaxImbalanceThreshold(uint256 threshold) external onlyCurator {
		maxImbalanceThreshold = threshold;
	}

	// ---------------------------------------------------------------------------------------
	// ASSET VALUATION
	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Calculates the total asset value of the adapter using Curve's virtual price mechanism
	 * @return Total assets in stablecoin terms (18 decimals)
	 * @dev Uses get_virtual_price() which accounts for:
	 *      - Accumulated trading fees (LP appreciation)
	 *      - Current pool composition and ratios
	 *      - Standard DeFi LP valuation methodology
	 */
	function totalAssets() public view returns (uint256) {
		uint256 adapterLP = pool.balanceOf(address(this));
		if (adapterLP == 0) return 0;

		// Virtual price represents value per LP token including accumulated fees
		return (adapterLP * pool.get_virtual_price()) / 1 ether;
	}

	// ---------------------------------------------------------------------------------------
	// POOL IMBALANCE MANAGEMENT
	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Checks if the pool is in a state favorable for dual-sided liquidity addition
	 * @return true if pool is "coin-heavy" (stablecoin balance ≤ normalized coin balance)
	 * @dev Normalizes coin balance to 18 decimals for proper comparison.
	 *      When true, adding both tokens simultaneously should be profitable.
	 */
	function checkImbalance() public view returns (uint256, uint256, uint256) {
		// Normalize coin balance to 18 decimals for comparison
		uint256 coinAmount = (pool.balances(idxC) * 1 ether) / 10 ** coin.decimals();
		uint256 stableAmount = pool.balances(idxS);
		uint256 halfAmount = (coinAmount + stableAmount) / 2;

		if (stableAmount <= coinAmount) {
			return (idxS, coinAmount - stableAmount, 1 ether - (stableAmount * 1 ether) / halfAmount);
		} else {
			return (idxC, stableAmount - coinAmount, 1 ether - (coinAmount * 1 ether) / halfAmount);
		}
	}

	/**
	 * @notice Verifies that the pool imbalance state matches the expected condition and exceeds threshold
	 * @param state Expected imbalance state (true = coin-heavy, false = stablecoin-heavy)
	 * @dev Reverts if state doesn't match or if imbalance is below threshold (allowing free market)
	 */
	function verifyImbalance(bool state) public view {
		(uint256 deficientIndex, , uint256 deviation) = checkImbalance();
		
		// Check if deviation is below threshold - if so, block adapter operations
		if (deviation < maxImbalanceThreshold) {
			revert ImbalanceWithinThreshold(deviation, maxImbalanceThreshold);
		}
		
		// Verify the expected imbalance state matches actual state
		bool actualState = (deficientIndex == idxS); // true if stablecoin is deficient (coin-heavy)
		if (actualState != state) {
			revert ImbalancedVariant(pool.get_balances());
		}
	}

	// ---------------------------------------------------------------------------------------
	// LIQUIDITY PROVISION
	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Enables users to add liquidity via dual-sided provision when pool conditions are favorable
	 * @param amount Amount of external coin (e.g., USDC) to deposit
	 * @param minShares Minimum LP tokens the user expects to receive (slippage protection)
	 * @return LP tokens received by the user (50% of total minted)
	 * @dev Process:
	 *      1. User provides coin → Adapter mints equivalent stablecoin
	 *      2. Both tokens added to pool simultaneously
	 *      3. LP tokens split 50/50 between user and adapter
	 *      4. Verifies pool stays coin-heavy post-operation
	 */
	function addLiquidity(uint256 amount, uint256 minShares) external returns (uint256) {
		// Convert coin amount to equivalent stablecoin amount (decimal normalization)
		uint256 amountStable = (amount * 1 ether) / 10 ** coin.decimals();

		// Transfer user's coin tokens (requires prior approval)
		coin.safeTransferFrom(_msgSender(), address(this), amount);

		// Mint equivalent stablecoins to match the deposit
		stable.mintModule(address(this), amountStable);
		totalMinted += amountStable;

		// Approve both tokens for pool interaction
		stable.forceApprove(address(pool), amountStable);
		coin.forceApprove(address(pool), amount);

		// Prepare dual-token amounts for pool
		uint256[] memory amounts = new uint256[](2);
		amounts[idxS] = amountStable;
		amounts[idxC] = amount;

		// Add liquidity to pool with doubled minimum (since we're adding both sides)
		uint256 shares = pool.add_liquidity(amounts, minShares * 2);

		// Verify pool is still in favorable state (coin-heavy after our addition)
		verifyImbalance(true);

		// Give user half of the LP tokens, adapter keeps the other half
		uint256 split = shares / 2;
		pool.transfer(_msgSender(), split);

		// Emit event for tracking and return user's share
		emit AddLiquidity(_msgSender(), amountStable, totalMinted, split, pool.balanceOf(address(this)));
		return split;
	}

	// ---------------------------------------------------------------------------------------
	// DEBT CALCULATION UTILITIES
	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Calculates the amount of debt that should be burned based on LP token reduction
	 * @param beforeLP LP token balance before the operation
	 * @param afterLP LP token balance after the operation
	 * @return Amount of stablecoins to burn (proportional to LP reduction)
	 * @dev Uses proportional logic: if LP tokens reduce by X%, burn X% of totalMinted
	 */
	function calcBurnable(uint256 beforeLP, uint256 afterLP) public view returns (uint256) {
		// Calculate the proportional reduction ratio (scaled to 1e18)
		uint256 calcBurnableRatio = (1 ether - ((afterLP * 1 ether) / beforeLP));

		// Apply ratio to total minted debt to get burn amount
		return (calcBurnableRatio * totalMinted) / 1 ether;
	}

	// ---------------------------------------------------------------------------------------
	// LIQUIDITY REMOVAL
	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Enables users to remove liquidity when conditions are profitable
	 * @param shares Amount of LP tokens to redeem
	 * @param minAmount Minimum stablecoin amount expected (slippage protection)
	 * @return Amount of stablecoins received by the user
	 * @dev Enforces profitability check and imbalance verification.
	 */
	function removeLiquidity(uint256 shares, uint256 minAmount) external returns (uint256) {
		return _removeLiquidity(shares, minAmount, true);
	}

	/**
	 * @notice Emergency function allowing curator to redeem liquidity with debt coverage
	 * @param amountToTransfer Stablecoin amount curator provides to cover potential shortfall
	 * @param shares LP tokens to redeem from adapter's holdings
	 * @param minAmount Minimum stablecoin amount expected from redemption
	 * @return Amount redeemed (not returned to curator since this is emergency management)
	 * @dev Bypasses imbalance checks since curator is providing debt coverage
	 */
	function redeemLiquidity(uint256 amountToTransfer, uint256 shares, uint256 minAmount) external onlyCurator returns (uint256) {
		if (amountToTransfer != 0) {
			// Curator provides stablecoins to cover any potential debt shortfall
			stable.safeTransferFrom(_msgSender(), address(this), amountToTransfer);
		}
		return _removeLiquidity(shares, minAmount, false);
	}

	/**
	 * @dev Internal function handling both user and curator liquidity removal
	 * @param shares LP tokens to remove
	 * @param minAmount Minimum amount expected from removal
	 * @param toSplit true for user operations (with checks), false for curator emergency
	 * @return split How much got split with the user
	 */
	function _removeLiquidity(uint256 shares, uint256 minAmount, bool toSplit) internal returns (uint256 split) {
		// Record LP balance before operation for debt calculation
		uint256 beforeLP = pool.balanceOf(address(this));

		if (toSplit) {
			// User operation: transfer user's LP tokens and give them half the withdrawn amount
			pool.transferFrom(_msgSender(), address(this), shares);

			// Withdraw double the user's LP tokens as stablecoins, give user half
			split = pool.remove_liquidity_one_coin(shares * 2, int128(int256(idxS)), minAmount * 2) / 2;

			// Verify pool becomes stablecoin-heavy (favorable for withdrawal)
			verifyImbalance(false);

			// Transfer user's portion
			stable.transfer(_msgSender(), split);
		} else {
			// Curator emergency: redeem adapter's LP tokens directly
			pool.remove_liquidity_one_coin(shares, int128(int256(idxS)), minAmount);
		}

		// Calculate debt to burn based on LP reduction
		uint256 afterLP = pool.balanceOf(address(this));
		uint256 toBurn = calcBurnable(beforeLP, afterLP);

		// Check actual stablecoin balance (includes any injection)
		uint256 remaining = stable.balanceOf(address(this));

		// Ensure operation is profitable (enough stablecoins to cover debt)
		if (remaining < toBurn) revert NotProfitable(remaining, toBurn);

		// Burn the required debt amount
		uint256 reduced = _reduceMint(toBurn);

		// Detect and distribute any actual revenue (excess beyond debt coverage)
		if (remaining > reduced) {
			uint256 revenue = remaining - reduced;
			totalRevenue += revenue;

			emit Revenue(revenue, totalRevenue, totalMinted);

			// Distribute profit to configured recipients
			_distribute();
		}

		// Emit tracking event
		emit RemoveLiquidity(_msgSender(), reduced, totalMinted, shares, afterLP);
	}

	// ---------------------------------------------------------------------------------------
	// DEBT MANAGEMENT
	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Allows anyone to reduce adapter debt by providing stablecoins
	 * @param amount Amount of stablecoins to contribute for debt reduction
	 * @return Amount of debt actually reduced
	 * @dev Any excess stablecoins beyond debt are distributed as revenue.
	 *      Useful for external parties to help maintain adapter health.
	 */
	function reduceMint(uint256 amount) external returns (uint256) {
		if (amount != 0) {
			// Transfer stablecoins from caller
			stable.safeTransferFrom(_msgSender(), address(this), amount);
		}

		// Reduce debt by all available balance
		uint256 reduced = _reduceMint(stable.balanceOf(address(this)));

		// Distribute any remaining balance as revenue
		_distribute();

		return reduced;
	}

	/**
	 * @dev Internal function to burn stablecoins and reduce totalMinted debt
	 * @param amount Amount of stablecoins available to burn
	 * @return Amount of debt actually reduced
	 */
	function _reduceMint(uint256 amount) internal returns (uint256) {
		if (amount == 0) revert ZeroAmount();

		// Can only reduce up to the current debt amount
		uint256 reduce = totalMinted <= amount ? totalMinted : amount;

		if (totalMinted == reduce) {
			// Full debt payoff
			stable.burn(totalMinted);
			totalMinted = 0;
		} else {
			// Partial debt reduction
			stable.burn(reduce);
			totalMinted -= reduce;
		}

		return reduce;
	}

	// ---------------------------------------------------------------------------------------
	// PROFIT RECONCILIATION
	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Reconciles protocol profits when adapter assets exceed liabilities
	 * @return Amount of profit reconciled and distributed
	 * @dev Uses mint-and-distribute strategy: mints stablecoins equal to profit,
	 *      updates debt to match assets, then distributes the profit immediately.
	 *      This preserves LP tokens while realizing profits for the protocol.
	 *      Protected by ReconcileGuard with 50,000 block cooldown to ensure economically meaningful intervals
	 */
	function reconcile() external ReconcileGuard returns (uint256) {
		return _reconcile(totalAssets(), false);
	}

	/**
	 * @dev Internal reconciliation with optional passing (for future use)
	 * @param assets Current total asset value
	 * @param allowPassing If true, returns 0 when no profit; if false, reverts
	 * @return Amount of profit reconciled
	 */
	function _reconcile(uint256 assets, bool allowPassing) internal returns (uint256) {
		if (assets > totalMinted) {
			// Calculate profit: Assets (LP value) - Liabilities (minted debt)
			uint256 mintToReconcile = assets - totalMinted;
			totalRevenue += mintToReconcile;

			// Mint stablecoins equal to profit to balance the books
			stable.mintModule(address(this), mintToReconcile);
			totalMinted += mintToReconcile;
			emit Revenue(mintToReconcile, totalRevenue, totalMinted);

			// Distribute the newly minted profit to configured recipients
			_distribute();

			return mintToReconcile;
		} else {
			// No profit available for reconciliation
			if (allowPassing) {
				return 0;
			} else {
				revert NothingToReconcile(assets, totalMinted);
			}
		}
	}
}
