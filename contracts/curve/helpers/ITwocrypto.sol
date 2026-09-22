// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @notice Curve's two-coin crypto pool for uncorrelated/non-pegged assets (TwoCrypto-NG). The pool contract
///         is also the ERC20-compliant LP token. All prices are quoted with respect to coins(0).
/// @dev Mirrored from https://github.com/curvefi/twocrypto-ng/blob/main/contracts/main/Twocrypto.vy
interface ITwocrypto {
	// ----- Core Functions -----
	function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external returns (uint256);

	function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy, address receiver) external returns (uint256);

	function exchange_received(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external returns (uint256);

	function exchange_received(uint256 i, uint256 j, uint256 dx, uint256 min_dy, address receiver) external returns (uint256);

	function add_liquidity(uint256[2] calldata amounts, uint256 min_mint_amount) external returns (uint256);

	function add_liquidity(uint256[2] calldata amounts, uint256 min_mint_amount, address receiver) external returns (uint256);

	function remove_liquidity(uint256 amount, uint256[2] calldata min_amounts) external returns (uint256[2] memory);

	function remove_liquidity(uint256 amount, uint256[2] calldata min_amounts, address receiver) external returns (uint256[2] memory);

	function remove_liquidity_one_coin(uint256 lp_token_amount, uint256 i, uint256 min_amount) external returns (uint256);

	function remove_liquidity_one_coin(
		uint256 lp_token_amount,
		uint256 i,
		uint256 min_amount,
		address receiver
	) external returns (uint256);

	function remove_liquidity_fixed_out(
		uint256 token_amount,
		uint256 i,
		uint256 amount_i,
		uint256 min_amount_j
	) external returns (uint256);

	function remove_liquidity_fixed_out(
		uint256 token_amount,
		uint256 i,
		uint256 amount_i,
		uint256 min_amount_j,
		address receiver
	) external returns (uint256);

	// ----- Views: quoting -----
	function calc_token_amount(uint256[2] calldata amounts, bool deposit) external view returns (uint256);

	function calc_withdraw_one_coin(uint256 lp_token_amount, uint256 i) external view returns (uint256);

	function calc_withdraw_fixed_out(uint256 lp_token_amount, uint256 i, uint256 amount_i) external view returns (uint256);

	function get_dy(uint256 i, uint256 j, uint256 dx) external view returns (uint256);

	function get_dx(uint256 i, uint256 j, uint256 dy) external view returns (uint256);

	// ----- Views: pool state -----
	function lp_price() external view returns (uint256);

	function get_virtual_price() external view returns (uint256);

	function price_oracle() external view returns (uint256);

	function price_scale() external view returns (uint256);

	function last_prices() external view returns (uint256);

	function balances(uint256 i) external view returns (uint256);

	function coins(uint256 i) external view returns (address);

	function D() external view returns (uint256);

	function xcp_profit() external view returns (uint256);

	function xcp_profit_a() external view returns (uint256);

	function virtual_price() external view returns (uint256);

	// ----- Views: params -----
	function A() external view returns (uint256);

	function gamma() external view returns (uint256);

	function fee() external view returns (uint256);

	function mid_fee() external view returns (uint256);

	function out_fee() external view returns (uint256);

	function fee_gamma() external view returns (uint256);

	function allowed_extra_profit() external view returns (uint256);

	function adjustment_step() external view returns (uint256);

	function ma_time() external view returns (uint256);

	function factory() external view returns (address);

	function admin() external view returns (address);

	// ----- ERC20 (the pool contract is also the LP token) -----
	function totalSupply() external view returns (uint256);

	function balanceOf(address account) external view returns (uint256);

	function allowance(address owner, address spender) external view returns (uint256);

	function approve(address spender, uint256 amount) external returns (bool);

	function transfer(address to, uint256 amount) external returns (bool);

	function transferFrom(address from, address to, uint256 amount) external returns (bool);

	function name() external view returns (string memory);

	function symbol() external view returns (string memory);

	function decimals() external view returns (uint8);
}
