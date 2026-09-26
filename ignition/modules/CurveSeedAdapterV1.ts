import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';
import { ADDRESS } from '../../exports/address.config';
import { Address } from 'viem';
import { mainnet } from 'viem/chains';

// config and select
export const NAME: string = 'CurveSeedAdapterV1'; // <-- select smart contract
export const FILE: string = 'CurveSeedAdapterV1'; // <-- name exported file
export const MOD: string = NAME + 'Module';
console.log(NAME);

// params
export type DeploymentParams = {
	usdu: Address;
	pools: Address[];
};

export const params: DeploymentParams = {
	usdu: ADDRESS[mainnet.id].usduStable,
	pools: [ADDRESS[mainnet.id].curveTwocryptoNG_USDUEURU, ADDRESS[mainnet.id].curveTwocryptoNG_USDUCHFU],
};

export type ConstructorArgs = [Address, Address[]];

export const args: ConstructorArgs = [params.usdu, params.pools];

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
