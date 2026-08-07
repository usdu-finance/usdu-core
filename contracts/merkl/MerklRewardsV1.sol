// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import {IStablecoinModifier, Stablecoin} from '../stablecoin/IStablecoinModifier.sol';

import {IMerklDistributor} from './helpers/IMerklDistributor.sol';

/**
 * @title MerklRewardsV1
 * @author @samclassix <samclassix@proton.me>
 * @notice Abstract module giving a vault adapter the ability to claim its Merkl-distributed incentives and
 *         forward them straight to the stablecoin curator. Claimed tokens are curator-selected and never
 *         retained by the adapter, so an adapter integrating this module takes on no custody risk from
 *         arbitrary or malicious reward tokens beyond the scope of a single `claimRewards` call.
 */
abstract contract MerklRewardsV1 is IStablecoinModifier, ReentrancyGuard {
	using SafeERC20 for IERC20;

	IMerklDistributor public immutable distributor;

	// ---------------------------------------------------------------------------------------

	event ClaimRewards(address indexed token, uint256 amount, address indexed to);

	// ---------------------------------------------------------------------------------------

	constructor(Stablecoin _stable, IMerklDistributor _distributor) IStablecoinModifier(_stable) {
		distributor = _distributor;
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Claims pending Merkl rewards for this contract and forwards them to the curator.
	/// @dev Curator-gated and reentrancy-guarded: `tokens` are arbitrary, curator-selected ERC20s that may
	///      run untrusted code on `balanceOf`/`transfer`. Only the amount gained by this specific claim is
	///      forwarded, so a token pre-existing in this contract's balance is never swept alongside it.
	/// @param tokens Reward tokens to claim, selected off-chain via the Merkl API.
	/// @param amounts Cumulative claimable amount per token, as reported by Merkl.
	/// @param proofs Merkle proof per token, as reported by Merkl.
	function claimRewards(
		address[] calldata tokens,
		uint256[] calldata amounts,
		bytes32[][] calldata proofs
	) external onlyCurator nonReentrant {
		address[] memory users = new address[](tokens.length);
		uint256[] memory balancesBefore = new uint256[](tokens.length);
		for (uint256 i; i < tokens.length; i++) {
			users[i] = address(this);
			balancesBefore[i] = IERC20(tokens[i]).balanceOf(address(this));
		}

		distributor.claim(users, tokens, amounts, proofs);

		address to = stable.curator();
		for (uint256 i; i < tokens.length; i++) {
			uint256 claimed = IERC20(tokens[i]).balanceOf(address(this)) - balancesBefore[i];
			if (claimed == 0) continue;

			IERC20(tokens[i]).safeTransfer(to, claimed);
			emit ClaimRewards(tokens[i], claimed, to);
		}
	}
}
