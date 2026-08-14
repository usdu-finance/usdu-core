// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

/// @title IGPv2Settlement
/// @notice Minimal interface for the CoW Protocol GPv2Settlement contract (mainnet:
///         0x9008D19f58AAbD9eD0D60971565AA8510560ab41), covering the presign-based intent flow used to
///         authorize an order without an off-chain ECDSA signature: approve the vault relayer, call
///         setPreSignature, and let a solver fill the order asynchronously. filledAmount and
///         invalidateOrder let the order owner check settlement status and cancel an unfilled order
///         on-chain, without depending on an off-chain indexer.
interface IGPv2Settlement {
	/// @notice The GPv2VaultRelayer contract that actually pulls `sellToken` from an order owner's balance
	///         at settlement time (mainnet: 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110). Must be approved
	///         for `sellAmount` before an order can be filled.
	function vaultRelayer() external view returns (address);

	/// @notice The EIP-712 domain separator used for hashing orders via GPv2Order.hash.
	function domainSeparator() external view returns (bytes32);

	/// @notice For a fill-or-kill order, non-zero once the order has been executed by a solver: equal to
	///         the order's sellAmount for a sell order, or buyAmount for a buy order.
	function filledAmount(bytes calldata orderUid) external view returns (uint256);

	/// @notice Authorizes (or revokes authorization for) `orderUid` to be settled on behalf of this
	///         contract, in lieu of an off-chain ECDSA signature. Must be called by the order's owner.
	function setPreSignature(bytes calldata orderUid, bool signed) external;

	/// @notice Invalidates `orderUid`, preventing it from being filled. Must be called by the order's
	///         owner. Used to cancel an order that expired (`validTo` elapsed) without being filled.
	function invalidateOrder(bytes calldata orderUid) external;
}
