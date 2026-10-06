import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';
import { ADDRESS } from '../../exports/address.config';
import { Address } from 'viem';
import { mainnet } from 'viem/chains';

// config and select
export const NAME: string = 'FxArbitrageEuruV1'; // <-- select smart contract
export const FILE: string = 'FxArbitrageEuruV1'; // <-- name exported file
export const MOD: string = NAME + 'Module';
console.log(NAME);

// params
export type DeploymentParams = {
	owner: Address;
	morpho: Address;
	uniswapRouter02: Address;
	bridge: Address;
	euruPool: Address;
	usduPool: Address;
};

export const params: DeploymentParams = {
	owner: '0x0170F42f224b99CcbbeE673093589c5f9691dd06', // receives the profit, sole caller of execute()
	morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', // Morpho Blue (fee-free flash loans)
	uniswapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
	bridge: ADDRESS[mainnet.id].euruSwapBridgeMorphoV1_steakEURC_module, // EURC <-> EURU
	euruPool: ADDRESS[mainnet.id].curveTwocryptoNG_USDUEURU, // coin(0) USDU, coin(1) EURU
	usduPool: ADDRESS[mainnet.id].curveStableSwapNG_USDCUSDU, // coin(0) USDC, coin(1) USDU
};

export type ConstructorArgs = [Address, Address, Address, Address, Address, Address];

export const args: ConstructorArgs = [params.owner, params.morpho, params.uniswapRouter02, params.bridge, params.euruPool, params.usduPool];

console.log('Imported Params:');
console.log(params);

// export args
storeConstructorArgs(FILE, args);
console.log('Constructor Args');
console.log(args);

// fail safe
// process.exit();

export default buildModule(MOD, (m) => {
	return {
		[NAME]: m.contract(NAME, args),
	};
});
