// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @title IMerklDistributor
/// @notice Minimal interface for Merkl's onchain Distributor contract (see https://docs.merkl.xyz).
interface IMerklDistributor {
	/// @notice Claims rewards for a set of users.
	/// @dev Each index across the four arrays describes one claim: the earning account, the reward token,
	///      the cumulative claimable amount, and the merkle proof backing it. Claiming with `users[i]` set to
	///      the caller's own address requires no operator approval, since the claim is self-initiated.
	///      Amounts and proofs are sourced off-chain from Merkl (https://api.merkl.xyz).
	/// @param users The accounts the rewards are claimed for.
	/// @param tokens The reward token claimed at each index.
	/// @param amounts The cumulative claimable amount at each index.
	/// @param proofs The merkle proof backing each claim.
	function claim(
		address[] calldata users,
		address[] calldata tokens,
		uint256[] calldata amounts,
		bytes32[][] calldata proofs
	) external;
}
