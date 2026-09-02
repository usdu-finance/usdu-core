// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {IStablecoinModifier, IStablecoinMetadata} from '../stablecoin/IStablecoinModifier.sol';
import {ErrorsLib} from '../stablecoin/libraries/ErrorsLib.sol';

abstract contract RewardDistributionV1 is IStablecoinModifier {
	using Math for uint256;

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
	event Distribution(address indexed receiver, uint256 amount, uint256 ratio);

	// ---------------------------------------------------------------------------------------

	constructor(IStablecoinMetadata _stable, address[5] memory _receivers, uint32[5] memory _weights) IStablecoinModifier(_stable) {
		_setDistribution(_receivers, _weights);
	}

	// ---------------------------------------------------------------------------------------

	function setDistribution(address[5] calldata _receivers, uint32[5] calldata _weights) external onlyCurator {
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
		for (uint32 i = 0; i < 5; i++) {
			if (_receivers[i] == address(0)) continue;
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

	function _distribute() internal {
		// distribute all stables
		uint256 amount = stable.balanceOf(address(this));

		// distribution is not available
		if (totalWeights == 0 || amount == 0) return;

		for (uint256 i = 0; i < 5; i++) {
			address receiver = receivers[i];
			uint256 weight = weights[i];

			// end distribution
			if (receiver == address(0)) return;

			// distribute weighted split
			uint256 split = (weight * amount) / totalWeights;

			// distribute revenue split
			stable.transfer(receiver, split);

			// last weighted ratio might be inconsistant, due to remaining assets distribution
			emit Distribution(receiver, split, (weight * 1 ether) / totalWeights);
		}
	}
}
