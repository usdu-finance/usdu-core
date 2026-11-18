import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';
import { ADDRESS } from '../../exports/address.config';
import { Address } from 'viem';
import { mainnet } from 'viem/chains';

// config and select
export const NAME: string = 'StreamerDepositorV1'; // <-- select smart contract
export const FILE: string = 'StreamerDepositorV1'; // <-- name exported file
export const MOD: string = NAME + 'Module';
console.log(NAME);

// params
export type DeploymentParams = {
	stable: Address;
};

const addr = ADDRESS[mainnet.id];

// StreamerDepositorV1 has no owner of its own: the DAO is `stable.curator()`, resolved at call time, and the guardian may
// disable flows. One deployment serves all three stablecoins (USDU, EURU, CHFU), as they share the same curator (the DAO).
// After deployment the DAO must (per stablecoin) approve the depositor and call
// setFlow(token, vault, bps, cooldown, flowCap) to point it at the reward vault (StreamerVaultV1) of that stablecoin.
export const params: DeploymentParams = {
	stable: addr.usduStable, // its curator is the DAO whose stablecoin balances are streamed
};

export type ConstructorArgs = [Address];

export const args: ConstructorArgs = [params.stable];

console.log('Imported Params:');
console.log(params);

// export args
storeConstructorArgs(FILE, args);
console.log('Constructor Args');
console.log(args);

// fail safe: set CONFIRM_DEPLOY=1 to actually deploy
if (!process.env.CONFIRM_DEPLOY) process.exit();

export default buildModule(MOD, (m) => {
	return {
		[NAME]: m.contract(NAME, args),
	};
});
