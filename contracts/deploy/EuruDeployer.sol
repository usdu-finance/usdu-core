// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';

import {Stablecoin} from '../stablecoin/Stablecoin.sol';
import {IStablecoinMetadata} from '../stablecoin/IStablecoinMetadata.sol';

import {SwapRouterV1} from '../swap/router/SwapRouterV1.sol';
import {SwapBridgeMorphoV1} from '../swap/morpho/SwapBridgeMorphoV1.sol';
import {IMerklDistributor} from '../merkl/helpers/IMerklDistributor.sol';

contract EuruDeployer {
	Stablecoin public immutable stable;
	SwapRouterV1 public immutable router;
	SwapBridgeMorphoV1 public immutable bridge;

	constructor(
		address _curator,
		IMerklDistributor _distributor,
		IERC4626 _vault,
		uint256 _mintCap,
		uint24 _swapInFeePPM,
		uint24 _swapOutFeePPM
	) {
		// deploy stablecoin
		stable = new Stablecoin('EURU', 'EURU', address(this));

		// deploy generic swap entrypoint
		router = new SwapRouterV1(stable);

		// deploy swap bridge module and register it on the stable
		bridge = new SwapBridgeMorphoV1(
			IStablecoinMetadata(address(stable)),
			_distributor,
			_vault,
			_mintCap,
			_swapInFeePPM,
			_swapOutFeePPM
		);
		stable.setModule(address(bridge), block.timestamp + 5 * 365 days, 'SwapBridgeMorphoV1 - steakEURC');

		// prepare stable for curator
		stable.setCurator(_curator); // no timelock, new curator needs to accept role
		stable.setTimelock(7 days); // will apply now for further steps
	}
}
