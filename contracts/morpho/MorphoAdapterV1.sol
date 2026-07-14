// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {Context} from '@openzeppelin/contracts/utils/Context.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {Stablecoin} from '../stablecoin/Stablecoin.sol';
import {ErrorsLib} from '../stablecoin/libraries/ErrorsLib.sol';

import {IMetaMorphoV1_1} from './helpers/IMetaMorphoV1_1.sol';

/**
 * @title MorphoAdapterV1
 * @author @samclassix <samclassix@proton.me>
 * @notice This is an adapter for interacting with Morpho to mint liquidity straight into the market.
 */
contract MorphoAdapterV1 is Context {
	using Math for uint256;
	using SafeERC20 for Stablecoin;
	using SafeERC20 for IMetaMorphoV1_1;

	Stablecoin public immutable stable;
	IMetaMorphoV1_1 public immutable core;
	IMetaMorphoV1_1 public immutable staked;

	uint256 public totalMinted;
	uint256 public totalRevenue;

	address[5] public receivers;
	uint32[5] public weights;
	uint256 public totalWeights;

	address[5] public pendingReceivers;
	uint32[5] public pendingWeights;
	uint256 public pendingValidAt;

	// ---------------------------------------------------------------------------------------

	event SubmitDistribution(address indexed caller, address[5] receivers, uint32[5] weights, uint256 timelock);
	event RevokeDistribution(address indexed caller);
	event SetDistribution(address indexed caller);

	event Deposit(uint256 amount, uint256 sharesCore, uint256 sharesStaked, uint256 totalMinted);
	event Redeem(uint256 amount, uint256 sharesCore, uint256 sharesStaked, uint256 totalMinted);
	event Revenue(uint256 amount, uint256 totalRevenue, uint256 totalMinted);
	event Distribution(address indexed receiver, uint256 amount, uint256 ratio);

	// ---------------------------------------------------------------------------------------

	error ForwardCallFailed(address forwardedTo);
	error MismatchLength(uint256 receivers, uint256 weights);
	error NothingToReconcile(uint256 assets, uint256 minted);

	// ---------------------------------------------------------------------------------------

	modifier onlyCurator() {
		stable.verifyCurator(_msgSender());
		_;
	}

	modifier onlyCuratorOrGuardian() {
		stable.verifyCuratorOrGuardian(_msgSender());
		_;
	}

	modifier afterTimelock(uint256 validAt) {
		if (validAt == 0) revert ErrorsLib.NoPendingValue();
		if (block.timestamp < validAt) revert ErrorsLib.TimelockNotElapsed();
		_;
	}

	// ---------------------------------------------------------------------------------------

	constructor(
		Stablecoin _stable,
		IMetaMorphoV1_1 _core,
		IMetaMorphoV1_1 _staked,
		address[5] memory _receivers,
		uint32[5] memory _weights
	) {
		stable = _stable;
		core = _core;
		staked = _staked;
		_setDistribution(_receivers, _weights);
	}

	// ---------------------------------------------------------------------------------------

	function totalAssets() public view returns (uint256) {
		// this will use `_accruedFeeAndAssets`
		uint256 assetsFromStaked = staked.convertToAssets(staked.balanceOf(address(this)));
		return core.convertToAssets(assetsFromStaked);
	}

	// ---------------------------------------------------------------------------------------

	function setDistribution(address[5] calldata _receivers, uint32[5] calldata _weights) external onlyCurator {
		if (_receivers.length != _weights.length) revert MismatchLength(_receivers.length, _weights.length);
		if (pendingValidAt != 0) revert ErrorsLib.AlreadyPending();

		if (receivers[0] == address(0)) {
			_setDistribution(_receivers, _weights);
		} else {
			pendingReceivers = _receivers;
			pendingWeights = _weights;
			pendingValidAt = block.timestamp + stable.timelock();
			emit SubmitDistribution(_msgSender(), _receivers, _weights, pendingValidAt);
		}
	}

	function revokePendingDistribution() external onlyCuratorOrGuardian {
		if (pendingValidAt == 0) revert ErrorsLib.NoPendingValue();
		emit RevokeDistribution(_msgSender());
		_cleanUpPending();
	}

	function applyDistribution() external afterTimelock(pendingValidAt) {
		_setDistribution(pendingReceivers, pendingWeights);
	}

	function _setDistribution(address[5] memory _receivers, uint32[5] memory _weights) internal {
		// reset totalWeights
		totalWeights = 0;

		// update total weight
		for (uint32 i = 0; i < _receivers.length; i++) {
			totalWeights += _weights[i];
		}

		// update distribution
		receivers = _receivers;
		weights = _weights;

		// emit event
		emit SetDistribution(_msgSender());

		_cleanUpPending();
	}

	function _cleanUpPending() internal {
		delete pendingReceivers;
		delete pendingWeights;
		delete pendingValidAt;
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

		// approve staked shares for redeem from staked vault
		staked.forceApprove(address(staked), sharesStaked);
		uint256 sharesCore = staked.redeem(sharesStaked, address(this), address(this));

		// approve core shares for redeem from core vault
		core.forceApprove(address(core), sharesCore);
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
			uint256 bal = stable.balanceOf(address(this));
			if (bal > 0) {
				_distribute(bal);
			}
		}

		emit Redeem(amount, sharesCore, sharesStaked, totalMinted);
	}

	// ---------------------------------------------------------------------------------------

	function reconcile() external {
		_reconcile(totalAssets(), false);
	}

	function _reconcile(uint256 assets, bool allowPassing) internal returns (uint256) {
		if (assets > totalMinted) {
			uint256 mintToReconcile = assets - totalMinted;
			totalRevenue += mintToReconcile;

			stable.mintModule(address(this), mintToReconcile);
			totalMinted += mintToReconcile;
			emit Revenue(mintToReconcile, totalRevenue, totalMinted);

			_distribute(mintToReconcile);
			return mintToReconcile;
		} else {
			if (allowPassing) {
				return 0;
			} else {
				revert NothingToReconcile(assets, totalMinted);
			}
		}
	}

	// ---------------------------------------------------------------------------------------

	function _distribute(uint256 amount) internal {
		for (uint256 i = 0; i < 5; i++) {
			address receiver = receivers[i];
			uint256 weight = weights[i];
			uint256 split;

			// end distribution
			if (receiver == address(0)) return;

			// last item reached (index: 5 - 1 = 4) OR next receiver is zeroAddress
			if (i == 4 || (i < 4 && receivers[i + 1] == address(0))) {
				// distribute remainings, eliminating rounding or deposit issues
				split = stable.balanceOf(address(this));
			} else {
				// distribute weighted split
				split = (weight * amount) / totalWeights;
			}

			// distribute revenue split
			stable.transfer(receiver, split);

			// last weighted ratio might be inconsistant, due to remaining assets distribution
			emit Distribution(receiver, split, (weight * 1 ether) / totalWeights);
		}
	}
}
