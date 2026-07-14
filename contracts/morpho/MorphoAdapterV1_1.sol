// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {RewardDistributionV1, Stablecoin} from '../reward/RewardDistributionV1.sol';

import {IMetaMorphoV1_1} from './helpers/IMetaMorphoV1_1.sol';

/**
 * @title MorphoAdapterV1_1
 * @author @samclassix <samclassix@proton.me>
 * @notice This is an adapter for interacting with Morpho to mint liquidity straight into the market.
 */
contract MorphoAdapterV1_1 is RewardDistributionV1 {
	using Math for uint256;
	using SafeERC20 for Stablecoin;
	using SafeERC20 for IMetaMorphoV1_1;

	IMetaMorphoV1_1 public immutable core;
	IMetaMorphoV1_1 public immutable staked;

	uint256 public totalMinted;
	uint256 public totalRevenue;

	// ---------------------------------------------------------------------------------------

	event Deposit(uint256 amount, uint256 sharesCore, uint256 sharesStaked, uint256 totalMinted);
	event Redeem(uint256 amount, uint256 sharesCore, uint256 sharesStaked, uint256 totalMinted);
	event Revenue(uint256 amount, uint256 totalRevenue, uint256 totalMinted);

	// ---------------------------------------------------------------------------------------

	error NothingToReconcile(uint256 assets, uint256 minted);

	// ---------------------------------------------------------------------------------------

	constructor(
		Stablecoin _stable,
		IMetaMorphoV1_1 _core,
		IMetaMorphoV1_1 _staked,
		address[5] memory _receivers,
		uint32[5] memory _weights
	) RewardDistributionV1(_stable, _receivers, _weights) {
		core = _core;
		staked = _staked;
	}

	// ---------------------------------------------------------------------------------------

	function totalAssets() public view returns (uint256) {
		// this will use `_accruedFeeAndAssets`
		uint256 assetsFromStaked = staked.convertToAssets(staked.balanceOf(address(this)));
		return core.convertToAssets(assetsFromStaked);
	}

	// ---------------------------------------------------------------------------------------

	function deposit(uint256 amount) external onlyCurator {
		// mint stables
		stable.mintModule(address(this), amount);
		totalMinted += amount;

		// approve stable for deposit into core vault
		stable.forceApprove(address(core), amount);
		uint256 sharesCore = core.deposit(amount, address(this));

		// approve core shares for deposit into staked vault
		core.forceApprove(address(staked), sharesCore);
		uint256 sharesStaked = staked.deposit(sharesCore, address(this));

		emit Deposit(amount, sharesCore, sharesStaked, totalMinted);
	}

	// ---------------------------------------------------------------------------------------

	function redeem(uint256 sharesStaked) external onlyCurator {
		// reconcile, triggers `_accruedFeeAndAssets` in vault
		_reconcile(totalAssets(), true);

		// redeem staked shares from staked vault
		uint256 sharesCore = staked.redeem(sharesStaked, address(this), address(this));

		// redeem core shares from core vault
		uint256 amount = core.redeem(sharesCore, address(this), address(this));

		// reduce minted amount
		if (totalMinted >= amount) {
			stable.burn(amount);
			totalMinted -= amount;
		} else {
			// fallback, burn existing totalMinted if available
			if (totalMinted > 0) {
				stable.burn(totalMinted);
				totalMinted = 0;
			}

			// fallback, distribute remaining balance
			_distribute();
		}

		emit Redeem(amount, sharesCore, sharesStaked, totalMinted);
	}

	// ---------------------------------------------------------------------------------------

	function reconcile() external {
		_reconcile(totalAssets(), false);
	}

	function _reconcile(uint256 assets, bool allowPassing) internal returns (uint256) {
		if (assets > totalMinted) {
			// calc revenue
			uint256 mintToReconcile = assets - totalMinted;
			totalRevenue += mintToReconcile;

			// mint revenue to reconcile
			stable.mintModule(address(this), mintToReconcile);
			totalMinted += mintToReconcile;
			emit Revenue(mintToReconcile, totalRevenue, totalMinted);

			// distribute balance
			_distribute();

			return mintToReconcile;
		} else {
			if (allowPassing) {
				return 0;
			} else {
				revert NothingToReconcile(assets, totalMinted);
			}
		}
	}
}
