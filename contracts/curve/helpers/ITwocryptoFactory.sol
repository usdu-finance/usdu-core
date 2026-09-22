// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @notice Curve's permissionless two-coin crypto pool deployer and registry (TwoCrypto-NG).
/// @dev Mirrored from https://github.com/curvefi/twocrypto-ng/blob/main/contracts/main/TwocryptoFactory.vy
interface ITwocryptoFactory {
	function deploy_pool(
		string calldata name,
		string calldata symbol,
		address[2] calldata coins,
		uint256 implementation_id,
		uint256 A,
		uint256 gamma,
		uint256 mid_fee,
		uint256 out_fee,
		uint256 fee_gamma,
		uint256 allowed_extra_profit,
		uint256 adjustment_step,
		uint256 ma_exp_time,
		uint256 initial_price
	) external returns (address);

	function deploy_gauge(address pool) external returns (address);

	function find_pool_for_coins(address from, address to, uint256 i) external view returns (address);

	function pool_count() external view returns (uint256);

	function pool_list(uint256 index) external view returns (address);

	function get_coins(address pool) external view returns (address[2] memory);

	function get_decimals(address pool) external view returns (uint256[2] memory);

	function get_balances(address pool) external view returns (uint256[2] memory);

	function get_coin_indices(address pool, address from, address to) external view returns (uint256, uint256);

	function get_gauge(address pool) external view returns (address);

	function get_market_counts(address coinA, address coinB) external view returns (uint256);

	function pool_implementations(uint256 implementationId) external view returns (address);

	function gauge_implementation() external view returns (address);

	function views_implementation() external view returns (address);

	function math_implementation() external view returns (address);

	function admin() external view returns (address);

	function fee_receiver() external view returns (address);
}
