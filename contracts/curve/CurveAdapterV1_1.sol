// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {Context} from '@openzeppelin/contracts/utils/Context.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {RewardDistributionV1, Stablecoin} from '../reward/RewardDistributionV1.sol';

import {ICurveStableSwapNG} from './helpers/ICurveStableSwapNG.sol';

/**
 * @title CurveAdapterV1_1
 * @author @samclassix <samclassix@proton.me>
 * @notice This is an adapter for interacting with ICurveStableSwapNG to mint liquidity straight into the pool under certain conditions.
 */
contract CurveAdapterV1_1 is RewardDistributionV1 {
	using Math for uint256;
	using SafeERC20 for IERC20Metadata;
	using SafeERC20 for Stablecoin;

	ICurveStableSwapNG public immutable pool;
	IERC20Metadata public immutable coin;

	uint256 public immutable idxS;
	uint256 public immutable idxC;

	uint256 public totalMinted;
	uint256 public totalRevenue;

	// ---------------------------------------------------------------------------------------

	event AddLiquidity(address indexed sender, uint256 minted, uint256 totalMinted, uint256 sharesMinted, uint256 totalShares);
	event RemoveLiquidity(address indexed sender, uint256 burned, uint256 totalMinted, uint256 sharesBurned, uint256 totalShares);
	event Revenue(uint256 amount, uint256 totalRevenue, uint256 totalMinted);

	// ---------------------------------------------------------------------------------------

	error ImbalancedVariant(uint256[] balances);
	error NotProfitable();

	// ---------------------------------------------------------------------------------------

	constructor(
		ICurveStableSwapNG _pool,
		uint256 _idxS, // IStablecoin
		uint256 _idxC, // IERC20 coin
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

	function checkImbalance() public view returns (bool) {
		uint256 correctedAmount = (pool.balances(idxC) * 1 ether) / 10 ** coin.decimals();
		if (pool.balances(idxS) <= correctedAmount) {
			return true;
		} else {
			return false;
		}
	}

	function verifyImbalance(bool state) public view {
		if (checkImbalance() != state) revert ImbalancedVariant(pool.get_balances());
	}

	// ---------------------------------------------------------------------------------------

	function addLiquidity(uint256 amount, uint256 minShares) external returns (uint256) {
		uint256 amountStable = (amount * 1 ether) / 10 ** coin.decimals();

		// transfer coin token, needs approval
		coin.safeTransferFrom(_msgSender(), address(this), amount);

		// mint the same amountStable in stables
		stable.mintModule(address(this), amountStable);
		totalMinted += amountStable;

		// approve tokens
		stable.forceApprove(address(pool), amountStable);
		coin.forceApprove(address(pool), amount);

		// prepare amounts
		uint256[] memory amounts = new uint256[](2);
		amounts[idxS] = amountStable;
		amounts[idxC] = amount;

		// provide liquidity
		uint256 shares = pool.add_liquidity(amounts, minShares * 2);

		// verify imbalance for stable
		verifyImbalance(true);

		// return sender's split of shares
		uint256 split = shares / 2;
		pool.transfer(_msgSender(), split);

		// emit event and return share split
		emit AddLiquidity(_msgSender(), amountStable, totalMinted, split, pool.balanceOf(address(this)));
		return split;
	}

	// ---------------------------------------------------------------------------------------

	function calcProfitability(uint256 beforeLP, uint256 afterLP, uint256 split) public view returns (uint256) {
		// @dev: if all debt is already paid, `calcBeforeSplit` will be 0 and therefore profit is the whole `split`
		uint256 calcBeforeSplit = ((1 ether - ((afterLP * 1 ether) / beforeLP)) * totalMinted) / 1 ether;
		if (split > calcBeforeSplit) {
			return split - calcBeforeSplit;
		} else {
			return 0;
		}
	}

	// ---------------------------------------------------------------------------------------

	function removeLiquidity(uint256 shares, uint256 minAmount) external returns (uint256) {
		// store LP balance
		uint256 beforeLP = pool.balanceOf(address(this));

		// transfer LP shares from sender, needs approval
		pool.transferFrom(_msgSender(), address(this), shares);

		// remove both shares and get split
		uint256 split = pool.remove_liquidity_one_coin(shares * 2, int128(int256(idxS)), minAmount * 2) / 2;

		// verify imbalance for coin
		verifyImbalance(false);

		// verify if in profit
		uint256 afterLP = pool.balanceOf(address(this));
		uint256 profit = calcProfitability(beforeLP, afterLP, split);
		if (profit == 0) revert NotProfitable();
		totalRevenue += profit;

		// transfer split to sender
		stable.transfer(_msgSender(), split);

		// reconcile
		uint256 burned = _reconcile();

		// emit revenue with reduced totalMinted
		emit Revenue(profit, totalRevenue, totalMinted);

		// emit event and return share portion
		emit RemoveLiquidity(_msgSender(), burned, totalMinted, shares, afterLP);
		return split;
	}

	// ---------------------------------------------------------------------------------------
	// redeem, onlyCurator

	function redeem(uint256 shares, uint256 minAmount) external onlyCurator {
		pool.remove_liquidity_one_coin(shares, int128(int256(idxS)), minAmount);
		_reconcile();
	}

	// ---------------------------------------------------------------------------------------

	function payOffDebt() external onlyCuratorOrGuardian {
		_reconcile();
	}

	// ---------------------------------------------------------------------------------------

	function _reconcile() internal returns (uint256) {
		uint256 amount = stable.balanceOf(address(this));
		if (totalMinted <= amount) {
			if (totalMinted != 0) {
				stable.burn(totalMinted);
				totalMinted = 0;
			}

			// distribute remainings
			_distribute();

			return totalMinted;
		} else {
			// fallback, burn existing totalMinted if available,
			// will leave with dust debt
			stable.burn(amount);
			totalMinted -= amount;
			return amount;
		}
	}
}
