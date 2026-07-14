// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {RewardDistributionV1, Stablecoin} from '../reward/RewardDistributionV1.sol';

/**
 * @title VaultAdapterV1
 * @author @samclassix <samclassix@proton.me>
 * @notice This contract serves as an adapter for interacting with vaults, facilitating the direct minting of liquidity into them.
 */
contract VaultAdapterV1 is RewardDistributionV1 {
	using Math for uint256;
	using SafeERC20 for IERC20;
	using SafeERC20 for IERC4626;
	using SafeERC20 for Stablecoin;

	IERC4626 public immutable vault;

	uint256 public totalMinted;
	uint256 public totalRevenue;

	// ---------------------------------------------------------------------------------------

	event Deposit(uint256 amount, uint256 sharesCore, uint256 totalMinted);
	event Redeem(uint256 amount, uint256 sharesCore, uint256 totalMinted);
	event Revenue(uint256 amount, uint256 totalRevenue, uint256 totalMinted);

	// ---------------------------------------------------------------------------------------

	error NothingToReconcile(uint256 assets, uint256 minted);

	// ---------------------------------------------------------------------------------------

	constructor(
		Stablecoin _stable,
		IERC4626 _vault,
		address[5] memory _receivers,
		uint32[5] memory _weights
	) RewardDistributionV1(_stable, _receivers, _weights) {
		vault = _vault;
	}

	// ---------------------------------------------------------------------------------------

	function totalAssets() public view returns (uint256) {
		return vault.convertToAssets(vault.balanceOf(address(this)));
	}

	// ---------------------------------------------------------------------------------------

	function deposit(uint256 amount) external onlyCurator {
		// mint stables
		stable.mintModule(address(this), amount);
		totalMinted += amount;

		// approve stable for deposit into vault
		stable.forceApprove(address(vault), amount);
		uint256 sharesCore = vault.deposit(amount, address(this));

		emit Deposit(amount, sharesCore, totalMinted);
	}

	// ---------------------------------------------------------------------------------------

	function redeem(uint256 sharesCore) external onlyCurator {
		// reconcile
		_reconcile(totalAssets(), true);

		// redeem vault shares for stables
		vault.redeem(sharesCore, address(this), address(this));
		uint256 amount = stable.balanceOf(address(this));

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

		emit Redeem(amount, sharesCore, totalMinted);
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
