// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IMorpho} from '../morpho/helpers/IMorpho.sol';
import {IMorphoFlashLoanCallback} from '../morpho/helpers/IMorphoCallbacks.sol';
import {ISwapBridgeV1} from '../swap/general/ISwapBridgeV1.sol';
import {ITwocrypto} from '../curve/helpers/ITwocrypto.sol';
import {ICurveStableSwapNG} from '../curve/helpers/ICurveStableSwapNG.sol';

/// @dev Uniswap SwapRouter02 (v3), the only function used.
interface IUniswapSwapRouter02 {
	struct ExactInputParams {
		bytes path;
		address recipient;
		uint256 amountIn;
		uint256 amountOutMinimum;
	}

	function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @title FxArbitrageEuruV1
 * @notice Flash-loan arbitrage for the case where EURU is priced *rich* in the USDU/EURU Curve pool (e.g. after
 *         EUR dropped vs. USD and the pool has not repriced yet). Fee-free Morpho flash loan of EURC, then:
 *
 *           EURC --bridge swapIn--> EURU --USDU/EURU pool--> USDU --USDC/USDU pool--> USDC --Uniswap v3--> EURC
 *
 *         and the flash loan is repaid out of the proceeds. The whole transaction reverts unless at least
 *         `minProfit` EURC is left over, which is paid to the owner. The opposite direction (buying EURU in the
 *         pool and redeeming through the bridge) is intentionally not supported: the bridge can only redeem what
 *         it minted itself, so it is not available for EURU the pool was seeded with.
 * @dev Holds no funds between transactions and has no privileged state, so the unlimited approvals given to the
 *      (immutable, non-upgradeable) venues in the constructor are safe. `execute` is owner-only and the callback
 *      only accepts Morpho while `execute` is running, so nobody else can steer the contract's swaps. Sandwich
 *      attacks on the public mempool can at worst make the trade revert on `minProfit`, never lose funds - still,
 *      submit through a private relay to avoid paying gas for reverts.
 */
contract FxArbitrageEuruV1 is Ownable, IMorphoFlashLoanCallback {
	using SafeERC20 for IERC20;

	IMorpho public immutable morpho;
	IUniswapSwapRouter02 public immutable uniswap;
	ISwapBridgeV1 public immutable bridge; // EURC <-> EURU
	ITwocrypto public immutable euruPool; // coin(0) USDU, coin(1) EURU
	ICurveStableSwapNG public immutable usduPool; // coin(0) USDC, coin(1) USDU

	IERC20 public immutable eurc;
	IERC20 public immutable euru;
	IERC20 public immutable usdu;
	IERC20 public immutable usdc;

	bool private _active;

	// ---------------------------------------------------------------------------------------

	event Arbitrage(uint256 amount, uint256 profit);
	event Rescue(address indexed token, address indexed to, uint256 amount);

	error NotMorpho();
	error NotActive();
	error InsufficientProfit(uint256 got, uint256 required);
	error BadPath();

	// ---------------------------------------------------------------------------------------

	constructor(
		address _owner,
		IMorpho _morpho,
		IUniswapSwapRouter02 _uniswap,
		ISwapBridgeV1 _bridge,
		ITwocrypto _euruPool,
		ICurveStableSwapNG _usduPool
	) Ownable(_owner) {
		morpho = _morpho;
		uniswap = _uniswap;
		bridge = _bridge;
		euruPool = _euruPool;
		usduPool = _usduPool;

		IERC20 _eurc = IERC20(address(_bridge.coin()));
		IERC20 _usdu = IERC20(_euruPool.coins(0));
		IERC20 _euru = IERC20(_euruPool.coins(1));
		IERC20 _usdc = IERC20(_usduPool.coins(0));
		require(_usduPool.coins(1) == address(_usdu), 'pool mismatch');

		eurc = _eurc;
		euru = _euru;
		usdu = _usdu;
		usdc = _usdc;

		_eurc.forceApprove(address(_morpho), type(uint256).max); // flash loan repayment
		_eurc.forceApprove(address(_bridge), type(uint256).max);
		_euru.forceApprove(address(_euruPool), type(uint256).max);
		_usdu.forceApprove(address(_usduPool), type(uint256).max);
		_usdc.forceApprove(address(_uniswap), type(uint256).max);
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Runs the arbitrage with a flash loan of `amount` EURC; the profit in EURC goes to the owner.
	/// @param amount EURC to flash loan (6 decimals). Size it off-chain: slippage in the USDU/EURU pool caps it.
	/// @param uniPath Uniswap v3 path USDC -> ... -> EURC, packed as (token, fee, token[, fee, token...]).
	/// @param minProfit Minimum EURC left after repaying the loan, otherwise the whole transaction reverts.
	function execute(uint256 amount, bytes calldata uniPath, uint256 minProfit) external onlyOwner returns (uint256 profit) {
		// path must start in USDC and end in EURC, so the last swap leg really refills the flash-loaned token
		if (uniPath.length < 43 || address(bytes20(uniPath[:20])) != address(usdc) || address(bytes20(uniPath[uniPath.length - 20:])) != address(eurc))
			revert BadPath();

		_active = true;
		morpho.flashLoan(address(eurc), amount, abi.encode(uniPath, minProfit));
		_active = false;

		profit = eurc.balanceOf(address(this));
		eurc.safeTransfer(owner(), profit);
		emit Arbitrage(amount, profit);
	}

	/// @inheritdoc IMorphoFlashLoanCallback
	function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
		if (msg.sender != address(morpho)) revert NotMorpho();
		if (!_active) revert NotActive();

		(bytes memory uniPath, uint256 minProfit) = abi.decode(data, (bytes, uint256));

		// EURC -> EURU (bridge, 10 bps fee)
		bridge.swapIn(assets);
		// EURU -> USDU
		euruPool.exchange(1, 0, euru.balanceOf(address(this)), 0);
		// USDU -> USDC
		usduPool.exchange(1, 0, usdu.balanceOf(address(this)), 0);
		// USDC -> EURC
		uniswap.exactInput(IUniswapSwapRouter02.ExactInputParams(uniPath, address(this), usdc.balanceOf(address(this)), 0));

		// Morpho pulls `assets` back right after this returns; whatever is above that is profit
		uint256 balance = eurc.balanceOf(address(this));
		if (balance < assets + minProfit) revert InsufficientProfit(balance > assets ? balance - assets : 0, minProfit);
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Recovers any token that ended up here by mistake (the contract never keeps funds on purpose).
	function rescue(IERC20 token, address to) external onlyOwner {
		uint256 amount = token.balanceOf(address(this));
		token.safeTransfer(to, amount);
		emit Rescue(address(token), to, amount);
	}
}
