import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';
import { ADDRESS } from '../../exports/address.config';
import { Address, zeroAddress } from 'viem';
import { mainnet } from 'viem/chains';

// config and select
export const NAME: string = 'CurveAdapterV1_2'; // <-- select smart contract
export const FILE: string = 'CurveAdapterV1_2'; // <-- name exported file
export const MOD: string = NAME + 'Module';
console.log(NAME);

// params
export type DeploymentParams = {
	pool: Address;
	idxS: number;
	idxC: number;
	receivers: Address[];
	weights: number[];
};

export const params: DeploymentParams = {
	pool: ADDRESS[mainnet.id].curveStableSwapNG_USDCUSDU,
	idxS: 1,
	idxC: 0,
	receivers: [ADDRESS[mainnet.id].curator, zeroAddress, zeroAddress, zeroAddress, zeroAddress],
	weights: [1_000_000, 0, 0, 0, 0],
};

export type ConstructorArgs = [Address, number, number, Address[], number[]];

export const args: ConstructorArgs = [params.pool, params.idxS, params.idxC, params.receivers, params.weights];

console.log('Imported Params:');
console.log(params);

// export args
storeConstructorArgs(FILE, args);
console.log('Constructor Args');
console.log(args);

// fail safe
process.exit();

export default buildModule(MOD, (m) => {
	return {
		[NAME]: m.contract(NAME, args),
	};
});
