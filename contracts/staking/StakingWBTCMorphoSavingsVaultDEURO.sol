// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ERC4626, ERC20, IERC20, IERC4626} from '@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {ISwapRouter} from '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';

import {IMorpho, MarketParams, Market, Position, Id} from '../morpho/helpers/IMorpho.sol';
import {MarketParamsLib} from '../morpho/helpers/MarketParamsLib.sol';
import {SharesMathLib} from '../morpho/helpers/SharesMathLib.sol';
import {IOracle} from '../morpho/helpers/IOracle.sol';

import {IStablecoinBridge} from './helpers/IStablecoinBridge.sol';
import {ISavingsVault} from './helpers/ISavingsVault.sol';
import {IStakingWBTCMorphoSavingsVaultDEURO} from './IStakingWBTCMorphoSavingsVaultDEURO.sol';

/**
 * @title StakingWBTCMorphoSavingsVaultDEURO
 * @author @samclassix <samclassix@proton.me>
 * @notice ERC-4626 vault, asset = WBTC. Deposits are supplied as collateral into a single Morpho Blue
 *         market (WBTC collateral / EURC loan). The vault then runs a leveraged carry trade against that
 *         collateral: it borrows EURC, bridges it 1:1 into dEURO (IStablecoinBridge), and deposits the
 *         dEURO into `savingsVault` (a SavingsVault holding svDEURO) to earn the dEURO savings rate.
 *
 * @dev Two independent, self-contained mechanisms keep the position healthy and growing:
 *
 *      1. `checkUpkeep`/`performUpkeep` (Chainlink Automation's actual interface, so this vault can be
 *         registered as an upkeep as-is) track `targetLtv +/- targetBand`: if the LTV drifts above the
 *         band, `_deleverage` redeems dEURO principal out of `savingsVault`, bridges it back to EURC, and
 *         repays Morpho; if it drifts below, `_leverage` borrows more EURC and deposits it into
 *         `savingsVault`. Neither direction needs external price data, so both stay honestly
 *         Automation-compatible: `performUpkeep` never trusts `performData`, it always recomputes the
 *         action live.
 *
 *      2. `reconcile` realizes the yield: whenever `savingsVault`'s live redeemable value exceeds the
 *         live Morpho debt (both read fresh, no cost-basis bookkeeping needed), it borrows exactly that
 *         surplus — rather than redeeming it out of savings — and swaps the freshly-borrowed EURC for
 *         WBTC through a fixed Uniswap V3 router, supplying the proceeds as collateral. Borrowing instead of
 *         redeeming leaves the existing savings position fully invested and compounding. This is the one
 *         operation that needs a live swap route, which can't be produced inside an on-chain simulation
 *         (`checkUpkeep` is a plain `eth_call`, it can't fetch a quote), so it is intentionally kept
 *         outside the Automation interface: a keeper supplies the swap `path` directly, with amountIn,
 *         amountOutMin, `to` and `deadline` all computed on-chain — the only trust placed in the path is
 *         the oracle-anchored minimum-output check enforced by the router itself, so a bad path just
 *         reverts, it can never drain more than the surplus being reconciled.
 */
contract StakingWBTCMorphoSavingsVaultDEURO is ERC4626, Ownable, ReentrancyGuard, IStakingWBTCMorphoSavingsVaultDEURO {
	using Math for uint256;
	using SharesMathLib for uint256;

	uint256 internal constant WAD = 1e18;
	uint256 internal constant ORACLE_SCALE = 1e36;
	uint256 internal constant PPM = 1_000_000;

	/// @notice Safety margin kept between `targetLtv + targetBand` and the market's liquidation LTV, so
	///         rebalancing always has room to act before a position becomes liquidatable.
	uint256 public constant LTV_SAFETY_MARGIN = 0.02e18;

	uint256 public constant MAX_SLIPPAGE_PPM = 50_000; // 5%

	// ---------------------------------------------------------------------------------------

	IMorpho public immutable morpho;
	Id public immutable marketId;
	IOracle internal immutable oracle;
	address internal immutable irm;
	uint256 internal immutable lltv;

	IStablecoinBridge public immutable bridge;
	IERC20 internal immutable loanToken; // EURC
	IERC20 internal immutable deuro;
	ISavingsVault public immutable savingsVault;
	uint256 internal immutable eurcToDeuroScale; // 10 ** (deuro.decimals() - loanToken.decimals())

	ISwapRouter public immutable uniswapRouter;

	uint256 public targetLtv;
	uint256 public targetBand;
	uint256 public swapSlippagePPM = 10_000; // 1%

	uint256 public reconcileThreshold;
	uint256 public reconcileInterval = 1 hours;
	uint256 public lastReconciledAt;

	// ---------------------------------------------------------------------------------------

	constructor(ConstructorParams memory params) ERC4626(params.wbtc) ERC20(params.name, params.symbol) Ownable(params.owner) {
		if (params.market.collateralToken != address(params.wbtc)) revert InvalidMarket();
		if (params.market.loanToken != address(params.bridge.eur())) revert InvalidMarket();
		if (address(params.bridge.dEURO()) != params.savingsVault.asset()) revert InvalidMarket();

		morpho = params.morpho;
		marketId = MarketParamsLib.id(params.market);
		oracle = IOracle(params.market.oracle);
		irm = params.market.irm;
		lltv = params.market.lltv;

		bridge = params.bridge;
		loanToken = IERC20(params.market.loanToken);
		deuro = params.bridge.dEURO();
		savingsVault = params.savingsVault;
		eurcToDeuroScale = 10 ** (IERC20Metadata(address(deuro)).decimals() - IERC20Metadata(params.market.loanToken).decimals());

		uniswapRouter = params.uniswapRouter;

		_setTargetLtv(params.targetLtv);
		_setTargetBand(params.targetBand);
		reconcileThreshold = params.reconcileThreshold;

		SafeERC20.forceApprove(params.wbtc, address(params.morpho), type(uint256).max);
		SafeERC20.forceApprove(IERC20(params.market.loanToken), address(params.morpho), type(uint256).max);
		SafeERC20.forceApprove(IERC20(params.market.loanToken), address(params.bridge), type(uint256).max);
		SafeERC20.forceApprove(IERC20(address(deuro)), address(params.bridge), type(uint256).max);
		SafeERC20.forceApprove(IERC20(address(deuro)), address(params.savingsVault), type(uint256).max);
	}

	// ---------------------------------------------------------------------------------------
	// Owner configuration

	function setTargetLtv(uint256 newTargetLtv) external onlyOwner {
		_setTargetLtv(newTargetLtv);
	}

	function _setTargetLtv(uint256 newTargetLtv) internal {
		_checkLtvBounds(newTargetLtv, targetBand);
		emit TargetLtvChanged(targetLtv, newTargetLtv);
		targetLtv = newTargetLtv;
	}

	function setTargetBand(uint256 newTargetBand) external onlyOwner {
		_setTargetBand(newTargetBand);
	}

	function _setTargetBand(uint256 newTargetBand) internal {
		_checkLtvBounds(targetLtv, newTargetBand);
		emit TargetBandChanged(targetBand, newTargetBand);
		targetBand = newTargetBand;
	}

	function _checkLtvBounds(uint256 _targetLtv, uint256 _targetBand) internal view {
		if (_targetLtv + _targetBand + LTV_SAFETY_MARGIN > lltv) revert LtvOutOfBounds(_targetLtv, _targetBand, lltv);
	}

	function setSwapSlippagePPM(uint256 newSlippagePPM) external onlyOwner {
		if (newSlippagePPM > MAX_SLIPPAGE_PPM) revert SlippageTooHigh(newSlippagePPM, MAX_SLIPPAGE_PPM);
		emit SwapSlippageChanged(swapSlippagePPM, newSlippagePPM);
		swapSlippagePPM = newSlippagePPM;
	}

	function setReconcileThreshold(uint256 newThreshold) external onlyOwner {
		emit ReconcileThresholdChanged(reconcileThreshold, newThreshold);
		reconcileThreshold = newThreshold;
	}

	function setReconcileInterval(uint256 newInterval) external onlyOwner {
		emit ReconcileIntervalChanged(reconcileInterval, newInterval);
		reconcileInterval = newInterval;
	}

	// ---------------------------------------------------------------------------------------
	// Views

	function _marketParams() internal view returns (MarketParams memory) {
		return MarketParams({loanToken: address(loanToken), collateralToken: asset(), oracle: address(oracle), irm: irm, lltv: lltv});
	}

	/// @dev Outstanding EURC debt, in loanToken units. Read from the last-accrued Morpho state; callers on
	///      the state-changing path call `morpho.accrueInterest` first so this is exact within that tx.
	function _debtAssets() internal view returns (uint256) {
		Position memory p = morpho.position(marketId, address(this));
		if (p.borrowShares == 0) return 0;
		Market memory m = morpho.market(marketId);
		return uint256(p.borrowShares).toAssetsUp(m.totalBorrowAssets, m.totalBorrowShares);
	}

	function _collateral() internal view returns (uint256) {
		return morpho.position(marketId, address(this)).collateral;
	}

	function _ltv() internal view returns (uint256) {
		uint256 collateral = _collateral();
		if (collateral == 0) return 0;
		uint256 debtInCollateral = _debtAssets().mulDiv(ORACLE_SCALE, oracle.price());
		return debtInCollateral.mulDiv(WAD, collateral);
	}

	/// @dev Live EURC value of `savingsVault`'s redeemable dEURO, minus live Morpho debt. Both sides are
	///      read fresh (no principal/cost-basis bookkeeping): the savings position and the debt are meant
	///      to track each other 1:1 through `_leverage`/`_deleverage`/`reconcile`, so whatever redeemable
	///      value has pulled ahead of debt is exactly the interest-rate spread earned so far.
	function _reconcileDelta() internal view returns (uint256) {
		uint256 savingsValue = _toEurc(savingsVault.previewRedeem(savingsVault.balanceOf(address(this))));
		uint256 debt = _debtAssets();
		return savingsValue > debt ? savingsValue - debt : 0;
	}

	function _toDeuro(uint256 eurcAmount) internal view returns (uint256) {
		return eurcAmount * eurcToDeuroScale;
	}

	function _toEurc(uint256 deuroAmount) internal view returns (uint256) {
		return deuroAmount / eurcToDeuroScale;
	}

	/// @notice Net asset value in WBTC: collateral + idle WBTC, plus the savings position and any idle
	///         EURC (both converted through the bridge's 1:1 peg and the Morpho oracle), minus outstanding
	///         debt. Value that is mid-flight in a `reconcile` call still shows up here, since the borrow
	///         and the swap happen atomically in the same transaction.
	function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
		uint256 collateral = _collateral();
		uint256 idleWbtc = IERC20(asset()).balanceOf(address(this));
		uint256 debt = _debtAssets();

		uint256 savingsValue = _toEurc(savingsVault.previewRedeem(savingsVault.balanceOf(address(this))));
		uint256 idleEurc = loanToken.balanceOf(address(this)) + savingsValue;

		uint256 price = oracle.price();
		if (idleEurc >= debt) {
			return collateral + idleWbtc + (idleEurc - debt).mulDiv(ORACLE_SCALE, price);
		} else {
			uint256 shortfall = (debt - idleEurc).mulDiv(ORACLE_SCALE, price);
			uint256 gross = collateral + idleWbtc;
			return gross > shortfall ? gross - shortfall : 0;
		}
	}

	// ---------------------------------------------------------------------------------------
	// Chainlink Automation — LTV-band leverage/deleverage only. Both directions are fully self-contained
	// (Morpho + bridge + savingsVault, no external price data), so they're the only actions safe to drive
	// through checkUpkeep/performUpkeep: an Automation node's checkUpkeep call is a plain simulation with
	// no HTTP access, so it could never produce a live swap route for `reconcile`.

	function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData) {
		Action action = _pendingLtvAction();
		return (action != Action.NONE, abi.encode(action));
	}

	/// @dev `performData` is intentionally ignored beyond existing to satisfy the interface — the action is
	///      always recomputed live, per the interface's own "never trust performData" guidance.
	function performUpkeep(bytes calldata) external nonReentrant {
		morpho.accrueInterest(_marketParams());

		Action action = _pendingLtvAction();
		if (action == Action.NONE) return;

		uint256 collateral = _collateral();
		uint256 debt = _debtAssets();
		uint256 targetDebt = collateral.mulDiv(oracle.price(), ORACLE_SCALE).mulDiv(targetLtv, WAD);

		if (action == Action.DELEVERAGE) {
			_deleverage(debt - targetDebt);
		} else {
			_leverage(targetDebt - debt);
		}

		emit Rebalanced(action);
	}

	function _pendingLtvAction() internal view returns (Action) {
		uint256 ltv = _ltv();
		if (ltv > targetLtv + targetBand) return Action.DELEVERAGE;
		if (targetLtv > targetBand && ltv < targetLtv - targetBand) return Action.LEVERAGE;
		return Action.NONE;
	}

	/// @dev Borrows `amount` EURC against existing collateral, bridges it 1:1 into dEURO, and deposits the
	///      proceeds into `savingsVault`. Sweeps this contract's full dEURO balance rather than just the
	///      freshly-bridged amount, so any dust left over from a prior `_deleverage` gets reinvested too.
	function _leverage(uint256 amount) internal {
		morpho.borrow(_marketParams(), amount, 0, address(this), address(this));

		bridge.mint(amount);
		uint256 deuroAmount = IERC20(address(deuro)).balanceOf(address(this));
		savingsVault.deposit(deuroAmount, address(this));

		emit Levered(amount, deuroAmount);
	}

	/// @dev Unwinds up to `amount` EURC of debt by redeeming the equivalent dEURO out of `savingsVault`,
	///      bridging it back to EURC, and repaying Morpho. Caps both legs by what's actually
	///      available/owed, since `amount` is only a target.
	function _deleverage(uint256 amount) internal {
		uint256 deuroNeeded = _toDeuro(amount);
		uint256 shares = Math.min(savingsVault.previewWithdraw(deuroNeeded), savingsVault.balanceOf(address(this)));
		if (shares == 0) return;

		uint256 redeemed = savingsVault.redeem(shares, address(this), address(this));
		bridge.burnAndSend(address(this), redeemed);

		uint256 eurcBalance = loanToken.balanceOf(address(this));
		uint256 debt = _debtAssets();
		uint256 repayAmount = Math.min(eurcBalance, debt);
		if (repayAmount > 0) morpho.repay(_marketParams(), repayAmount, 0, address(this), '');

		emit Delevered(repayAmount, redeemed);
	}

	// ---------------------------------------------------------------------------------------
	// Reconcile — realizes the savings/debt interest spread. Kept outside the Automation interface (see
	// contract-level @dev) since it needs a live swap route no on-chain simulation can produce.

	function reconcile(bytes calldata path) external nonReentrant {
		if (path.length < 43 || _firstToken(path) != address(loanToken) || _lastToken(path) != asset()) {
			revert InvalidSwapPath();
		}

		morpho.accrueInterest(_marketParams());

		uint256 delta = _reconcileDelta();
		if (delta < reconcileThreshold) revert ReconcileNotDue(delta, reconcileThreshold, 0);

		uint256 validAt = lastReconciledAt + reconcileInterval;
		if (block.timestamp < validAt) revert ReconcileNotDue(delta, reconcileThreshold, validAt);

		lastReconciledAt = block.timestamp;

		morpho.borrow(_marketParams(), delta, 0, address(this), address(this));

		uint256 minWbtcOut = delta.mulDiv(ORACLE_SCALE, oracle.price()).mulDiv(PPM - swapSlippagePPM, PPM);

		SafeERC20.forceApprove(loanToken, address(uniswapRouter), delta);
		// amountOut >= minWbtcOut is already enforced by the router itself (it reverts otherwise).
		uint256 bought = uniswapRouter.exactInput(
			ISwapRouter.ExactInputParams({
				path: path,
				recipient: address(this),
				deadline: block.timestamp,
				amountIn: delta,
				amountOutMinimum: minWbtcOut
			})
		);
		SafeERC20.forceApprove(loanToken, address(uniswapRouter), 0);

		morpho.supplyCollateral(_marketParams(), bought, address(this), '');

		emit Reconciled(delta, bought);
	}

	/// @dev Extracts the first 20 bytes (leading token) of a Uniswap V3 encoded path.
	function _firstToken(bytes calldata path) internal pure returns (address) {
		return address(bytes20(path[:20]));
	}

	/// @dev Extracts the last 20 bytes (trailing token) of a Uniswap V3 encoded path.
	function _lastToken(bytes calldata path) internal pure returns (address) {
		return address(bytes20(path[path.length - 20:]));
	}

	// ---------------------------------------------------------------------------------------
	// ERC4626 overrides

	function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
		SafeERC20.safeTransferFrom(IERC20(asset()), caller, address(this), assets);
		morpho.supplyCollateral(_marketParams(), assets, address(this), '');
		_mint(receiver, shares);
		emit Deposit(caller, receiver, assets, shares);
	}

	/// @dev Withdraws `assets` of WBTC straight out of the Morpho collateral position. Morpho's own health
	///      check reverts if that would push the remaining position above `lltv`, so a withdrawal that
	///      needs the vault to deleverage first must wait for `performUpkeep` to bring the LTV down, rather
	///      than being served as a partial fill.
	function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares) internal override {
		if (caller != owner) _spendAllowance(owner, caller, shares);
		_burn(owner, shares);
		morpho.withdrawCollateral(_marketParams(), assets, address(this), receiver);
		emit Withdraw(caller, receiver, owner, assets, shares);
	}
}
