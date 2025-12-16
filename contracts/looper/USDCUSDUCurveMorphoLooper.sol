// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IMorpho, MarketParams, Id, Position, Market} from '../morpho/helpers/IMorpho.sol';
import {IMetaMorphoV1_1} from '../morpho/helpers/IMetaMorphoV1_1.sol';
import {IMorphoFlashLoanCallback} from '../morpho/helpers/IMorphoCallbacks.sol';
import {IOracle} from '../morpho/helpers/IOracle.sol';
import {SharesMathLib} from '../morpho/helpers/SharesMathLib.sol';

import {ICurveStableSwapNG} from '../curve/helpers/ICurveStableSwapNG.sol';
import {CurveAdapterV1_1} from '../curve/CurveAdapterV1_1.sol';
import {MorphoStrategyWrapper} from './helpers/MorphoStrategyWrapper.sol';

contract USDCUSDUCurveMorphoLooper is Ownable, IMorphoFlashLoanCallback {
	using Math for uint256;
	using SharesMathLib for uint256;
	using SafeERC20 for IERC20;

	IMorpho public immutable morpho;
	IMetaMorphoV1_1 public immutable vault;
	ICurveStableSwapNG public immutable pool;

	IERC20 public immutable loan;
	IERC20 public immutable collateral;

	// opcodes
	uint8 public constant INCREASE_LEVERAGE = 0;
	uint8 public constant DECREASE_LEVERAGE = 1;
	uint8 public constant CLOSE_POSITION = 2;

	// vars
	MarketParams public market;

	// events
	event SupplyCollateral(uint256 amount, uint256 oraclePrice);
	event WithdrawCollateral(uint256 amount, uint256 oraclePrice);
	event RepayLoan(uint256 amount, uint256 oraclePrice);
	event BorrowLoan(uint256 amount, uint256 oraclePrice);
	event Executed(uint8 opcode, uint256 flash, uint256 swapIn, uint256 swapOut, uint256 provided);

	// errors
	error NotMorpho();
	error Invalid();
	error InvalidOpcode(uint8 given);
	error WrongEncodePathInputs();
	error WrongInputToken(address input, address needed);
	error WrongOutputToken(address output, address needed);
	error ExecutionFailed(uint256 index, bytes reason);

	constructor(
		address _morpho,
		address _vault,
		address _pool,
		address _loan,
		address _collateral,
		address _oracle,
		address _irm,
		uint256 _lltv,
		address _owner
	) Ownable(_owner) {
		morpho = IMorpho(_morpho);
		vault = IMetaMorphoV1_1(_vault);
		pool = ICurveStableSwapNG(_pool);

		loan = IERC20(_loan);
		collateral = IERC20(_collateral);

		market = MarketParams(_loan, _collateral, _oracle, _irm, _lltv);
	}

	// ---------------------------------------------------------------------------------------

	function getMarketId(MarketParams memory marketParams) public pure returns (bytes32) {
		return
			keccak256(
				abi.encode(marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv)
			);
	}

	// ---------------------------------------------------------------------------------------

	function getPrice() public view returns (uint256) {
		return IOracle(market.oracle).price();
	}

	// ---------------------------------------------------------------------------------------

	function supplyCollateral(uint256 assets) external onlyOwner {
		collateral.safeTransferFrom(msg.sender, address(this), assets); // needs allowance
		_supplyCollateral(assets);
		emit SupplyCollateral(assets, getPrice());
	}

	function _supplyCollateral(uint256 assets) internal {
		collateral.forceApprove(address(morpho), assets);
		morpho.supplyCollateral(market, assets, address(this), new bytes(0));
	}

	// ---------------------------------------------------------------------------------------

	function withdrawCollateral(uint256 assets) external onlyOwner {
		_withdrawCollateral(msg.sender, assets);
		emit WithdrawCollateral(assets, getPrice());
	}

	function _withdrawCollateral(address target, uint256 assets) internal {
		morpho.withdrawCollateral(market, assets, address(this), target);
	}

	function recover(address coin, address target, uint256 amount) external onlyOwner {
		IERC20(coin).transfer(target, amount);
	}

	// ---------------------------------------------------------------------------------------

	function borrow(uint256 assets) external onlyOwner returns (uint256 assetsBorrowed, uint256 sharesBorrowed) {
		(assetsBorrowed, sharesBorrowed) = _borrow(msg.sender, assets);
		emit BorrowLoan(assets, getPrice());
	}

	function _borrow(address target, uint256 assets) internal returns (uint256 assetsBorrowed, uint256 sharesBorrowed) {
		(assetsBorrowed, sharesBorrowed) = morpho.borrow(market, assets, 0, address(this), target);
	}

	// ---------------------------------------------------------------------------------------

	function repay(uint256 assets) external onlyOwner returns (uint256 assetsRepaid, uint256 sharesRepaid) {
		loan.safeTransferFrom(msg.sender, address(this), assets); // needs allowance
		(assetsRepaid, sharesRepaid) = _repay(assets);
		emit RepayLoan(assets, getPrice());
	}

	function _repay(uint256 assets) internal returns (uint256 assetsRepaid, uint256 sharesRepaid) {
		loan.forceApprove(address(morpho), assets);
		(assetsRepaid, sharesRepaid) = morpho.repay(market, assets, 0, address(this), new bytes(0));
	}

	function _repayShares(uint256 shares) internal returns (uint256 assetsRepaid, uint256 sharesRepaid) {
		loan.forceApprove(address(morpho), type(uint256).max);
		(assetsRepaid, sharesRepaid) = morpho.repay(market, 0, shares, address(this), new bytes(0));
	}

	// ---------------------------------------------------------------------------------------

	function increase(
		uint256 walletLoan, // add additional loan tkn
		uint256 walletColl, // add additional collateral tkn
		uint256 assets, // flashloan amount loan tkn
		address adapter // optional: use adapter
	) external onlyOwner {
		// add additional funds
		if (walletLoan > 0) {
			loan.safeTransferFrom(msg.sender, address(this), walletLoan); // needs allowance (loan tkn)
		}
		if (walletColl > 0) {
			collateral.safeTransferFrom(msg.sender, address(this), walletColl); // needs allowance (coll tkn)
		}

		// perform flashloan with data
		bytes memory data = abi.encode(INCREASE_LEVERAGE, adapter);
		morpho.flashLoan(address(loan), assets, data);
	}

	// ---------------------------------------------------------------------------------------

	function decrease(
		uint256 walletLoan, // add additional loan tkn
		uint256 walletColl, // add additional collateral tkn
		uint256 assets, // flashloan amount collateral tkn
		address adapter // optional: use adapter
	) external onlyOwner {
		// add additional funds
		if (walletLoan > 0) {
			loan.safeTransferFrom(msg.sender, address(this), walletLoan); // needs allowance (loan tkn)
		}
		if (walletColl > 0) {
			collateral.safeTransferFrom(msg.sender, address(this), walletColl); // needs allowance (coll tkn)
		}

		// perform flashloan with data
		bytes memory data = abi.encode(DECREASE_LEVERAGE, adapter);
		morpho.flashLoan(address(collateral), assets, data);
	}

	function close(
		address adapter // optional: use adapter
	) external onlyOwner {
		// calc
		Id marketId = Id.wrap(getMarketId(market));
		Position memory p = morpho.position(marketId, address(this));
		Market memory m = morpho.market(marketId);
		uint256 assets = (uint256(p.borrowShares).toAssetsUp(m.totalBorrowAssets, m.totalBorrowShares) * 11) / 10; // 110% (+10%)

		// perform flashloan with data
		bytes memory data = abi.encode(CLOSE_POSITION, adapter);
		morpho.flashLoan(address(loan), assets, data);
	}

	// ---------------------------------------------------------------------------------------

	function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
		if (msg.sender != address(morpho)) revert NotMorpho();

		// decode
		(uint8 opcode, address adapter) = abi.decode(data, (uint8, address));

		if (opcode == INCREASE_LEVERAGE) {
			// swap flashloan loan --> collateral
			uint256 amountIn = loan.balanceOf(address(this));
			uint256 amountOut = 0;

			address isCoin0 = pool.coins(0) == address(loan);
			uint256 calcOut = pool.calc_token_amount(isCoin0 ? [amountIn, 0] : [0, amountIn]);

			if (adapter == address(0)) {
				// use pool directly
				loan.forceApprove(address(pool), amountIn);
				amountOut = pool.add_liquidity(isCoin0 ? [amountIn, 0] : [0, amountIn], calcOut, address(this));
			} else {
				// use curve adapter, NOTICE: verifyImbalance & calcProfitability checks
				loan.forceApprove(address(adapter), amountIn);
				amountOut = CurveAdapterV1_1(adapter).addLiquidity(amountIn, calcOut);
			}

			// wrap and supply to morpho via collateral (MorphoStrategyWrapper)
			// supply collateral - includes any ERC20 Transfers from before
			uint256 amountLp = pool.balanceOf(address(this));
			pool.forceApprove(address(collateral), amountLp);
			MorphoStrategyWrapper(collateral).depositAssets(amountLp);

			// uint256 collateralAmount = collateral.balanceOf(address(this));
			// _supplyCollateral(collateralAmount);

			// borrow for flashloan repayment
			_borrow(address(this), assets);

			// forceApprove for flashloan repayment (loan)
			loan.forceApprove(address(morpho), assets);

			emit Executed(INCREASE_LEVERAGE, assets, amountIn, amountOut, collateralAmount);
		} else if (opcode == DECREASE_LEVERAGE) {
			// swap flashloan collateral --> loan
			uint256 amountIn = collateral.balanceOf(address(this));

			// forceApprove and execute swap
			collateral.forceApprove(address(savingsVault), amountIn);
			uint256 amountOut = savingsVault.redeem(amountIn, address(this), address(this));

			// repay loan - includes any ERC20 Transfers from before
			uint256 repayAmount = loan.balanceOf(address(this));
			_repay(repayAmount);

			// withdraw collateral for flashloan repayment
			_withdrawCollateral(address(this), assets);

			// forceApprove for flashloan repayment (collateral)
			collateral.forceApprove(address(morpho), assets);

			emit Executed(DECREASE_LEVERAGE, assets, amountIn, amountOut, repayAmount);
		} else if (opcode == CLOSE_POSITION) {
			// get infos
			Id marketId = Id.wrap(getMarketId(market));
			Position memory p = morpho.position(marketId, address(this));

			// repay loan
			_repayShares(p.borrowShares);

			// withdraw collateral
			_withdrawCollateral(address(this), p.collateral);

			// forceApprove and execute swap
			collateral.forceApprove(address(savingsVault), p.collateral);
			uint256 amountOut = savingsVault.redeem(p.collateral, address(this), address(this));

			// transfer equity balance
			uint256 equity = loan.balanceOf(address(this)) - assets;
			loan.transfer(owner(), equity);

			// forceApprove for flashloan repayment (loan)
			loan.forceApprove(address(morpho), assets);

			emit Executed(CLOSE_POSITION, assets, p.collateral, amountOut, equity);
		} else revert InvalidOpcode(opcode);
	}

	// ---------------------------------------------------------------------------------------

	function execute(
		address[] calldata targets,
		bytes[] calldata data,
		uint256 failMap
	) external onlyOwner returns (bytes[] memory results) {
		require(targets.length == data.length, 'Length mismatch');
		require(targets.length <= 256, 'Too many calls');

		results = new bytes[](targets.length);

		for (uint256 i = 0; i < targets.length; i++) {
			bool shouldRevert = (failMap >> i) & 1 == 0;

			(bool success, bytes memory result) = targets[i].call(data[i]);

			if (!success && shouldRevert) {
				revert ExecutionFailed(i, result);
			}

			results[i] = result;
		}

		return results;
	}
}
