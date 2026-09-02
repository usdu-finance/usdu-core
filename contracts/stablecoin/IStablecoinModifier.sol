// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Context} from '@openzeppelin/contracts/utils/Context.sol';

import {IStablecoinMetadata} from './IStablecoinMetadata.sol';
import {ErrorsLib} from './libraries/ErrorsLib.sol';

abstract contract IStablecoinModifier is Context {
	IStablecoinMetadata public immutable stable;

	modifier onlyCurator() {
		stable.verifyCurator(_msgSender());
		_;
	}

	modifier onlyGuardian() {
		stable.verifyGuardian(_msgSender());
		_;
	}

	modifier onlyCuratorOrGuardian() {
		stable.verifyCuratorOrGuardian(_msgSender());
		_;
	}

	modifier onlyModule() {
		stable.verifyModule(_msgSender());
		_;
	}

	modifier validModule() {
		stable.verifyValidModule(_msgSender());
		_;
	}

	modifier afterTimelock(uint256 validAt) {
		if (validAt == 0) revert ErrorsLib.NoPendingValue();
		if (block.timestamp < validAt) revert ErrorsLib.TimelockNotElapsed();
		_;
	}

	modifier claimPublicFee(uint256 fee, uint256 min) {
		if (fee < min) revert ErrorsLib.ProposalFeeToLow(min);
		stable.transferFrom(_msgSender(), stable.curator(), fee);
		_;
	}

	constructor(IStablecoinMetadata _stable) {
		stable = _stable;
	}
}
