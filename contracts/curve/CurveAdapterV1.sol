// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {Context} from '@openzeppelin/contracts/utils/Context.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {Stablecoin} from '../stablecoin/Stablecoin.sol';
import {ErrorsLib} from '../stablecoin/libraries/ErrorsLib.sol';
import {ICurveStableSwapNG} from './helpers/ICurveStableSwapNG.sol';

/**
 * @title CurveAdapterV1
 * @author @samclassix <samclassix@proton.me>
 * @notice This is an adapter for interacting with ICurveStableSwapNG to mint liquidity straight into the pool under certain conditions.
 */
contract CurveAdapterV1 is Context {
	using Math for uint256;
	using SafeERC20 for IERC20Metadata;
	using SafeERC20 for Stablecoin;

	ICurveStableSwapNG public immutable pool;
	Stablecoin public immutable stable;
	IERC20Metadata public immutable coin;

	uint256 public immutable idxS;
	uint256 public immutable idxC;

	uint256 public totalMinted;
	uint256 public totalRevenue;

	address[5] public receivers;
	uint32[5] public weights;
	uint256 public totalWeights;

	address[5] public pendingReceivers;
	uint32[5] public pendingWeights;
	uint256 public pendingValidAt;

	// ---------------------------------------------------------------------------------------

	event SubmitDistribution(address indexed caller, address[5] receivers, uint32[5] weights, uint256 timelock);
	event RevokeDistribution(address indexed caller);
	event SetDistribution(address indexed caller);

	event AddLiquidity(address indexed sender, uint256 minted, uint256 totalMinted, uint256 sharesMinted, uint256 totalShares);
	event RemoveLiquidity(address indexed sender, uint256 burned, uint256 totalMinted, uint256 sharesBurned, uint256 totalShares);
	event Revenue(uint256 amount, uint256 totalRevenue, uint256 totalMinted);
	event Distribution(address indexed receiver, uint256 amount, uint256 ratio);

	// ---------------------------------------------------------------------------------------

	error ImbalancedVariant(uint256[] balances);
	error NotProfitable();

	// ---------------------------------------------------------------------------------------

	modifier onlyCurator() {
		stable.verifyCurator(_msgSender());
		_;
	}

	modifier onlyCuratorOrGuardian() {
		stable.verifyCuratorOrGuardian(_msgSender());
		_;
	}

	modifier afterTimelock(uint256 validAt) {
		if (validAt == 0) revert ErrorsLib.NoPendingValue();
		if (block.timestamp < validAt) revert ErrorsLib.TimelockNotElapsed();
		_;
	}

	// ---------------------------------------------------------------------------------------

	constructor(
		ICurveStableSwapNG _pool,
		uint256 _idxS, // IStablecoin
		uint256 _idxC // IERC20 coin
	) {
		pool = _pool;

		require(_idxS < 8, 'idxS out of bounds for max 8 tokens');
		require(_idxC < 8, 'idxC out of bounds for max 8 tokens');

		idxS = _idxS;
		idxC = _idxC;

		stable = Stablecoin(_pool.coins(_idxS));
		coin = IERC20Metadata(_pool.coins(_idxC));
	}

	// ---------------------------------------------------------------------------------------

	function setDistribution(address[5] calldata _receivers, uint32[5] calldata _weights) external onlyCurator {
		if (pendingValidAt != 0) revert ErrorsLib.AlreadyPending();

		if (receivers[0] == address(0)) {
			_setDistribution(_receivers, _weights);
		} else {
			pendingReceivers = _receivers;
			pendingWeights = _weights;
			pendingValidAt = block.timestamp + stable.timelock();
			emit SubmitDistribution(_msgSender(), _receivers, _weights, pendingValidAt);
		}
	}

	function revokePendingDistribution() external onlyCuratorOrGuardian {
		if (pendingValidAt == 0) revert ErrorsLib.NoPendingValue();
		emit RevokeDistribution(_msgSender());
		_cleanUpPending();
	}

	function applyDistribution() external afterTimelock(pendingValidAt) {
		_setDistribution(pendingReceivers, pendingWeights);
	}

	function _setDistribution(address[5] memory _receivers, uint32[5] memory _weights) internal {
		// reset totalWeights
		totalWeights = 0;

		// update total weight
		for (uint32 i = 0; i < _receivers.length; i++) {
			totalWeights += _weights[i];
		}

		// update distribution
		receivers = _receivers;
		weights = _weights;

		// emit event
		emit SetDistribution(_msgSender());

		_cleanUpPending();
	}

	function _cleanUpPending() internal {
		delete pendingReceivers;
		delete pendingWeights;
		delete pendingValidAt;
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
			// in profit or neutral
			uint256 dist = amount - totalMinted;

			if (totalMinted != 0) {
				stable.burn(totalMinted);
				totalMinted = 0;
			}

			// distribute
			if (dist != 0) {
				_distribute(dist);
			}

			return totalMinted;
		} else {
			// fallback, burn existing totalMinted if available,
			// will leave with dust debt
			stable.burn(amount);
			totalMinted -= amount;
			return amount;
		}
	}

	function _distribute(uint256 amount) internal {
		for (uint256 i = 0; i < 5; i++) {
			address receiver = receivers[i];
			uint256 weight = weights[i];
			uint256 split;

			// end distribution
			if (receiver == address(0)) return;

			// last item reached (index: 5 - 1 = 4) OR next receiver is zeroAddress
			if (i == 4 || (i < 4 && receivers[i + 1] == address(0))) {
				// distribute remainings, eliminating rounding or deposit issues
				split = stable.balanceOf(address(this));
			} else {
				// distribute weighted split
				split = (weight * amount) / totalWeights;
			}

			// distribute revenue split
			stable.transfer(receiver, split);

			// last weighted ratio might be inconsistant, due to remaining assets distribution
			emit Distribution(receiver, split, (weight * 1 ether) / totalWeights);
		}
	}
}
