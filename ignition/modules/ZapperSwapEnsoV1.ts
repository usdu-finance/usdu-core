import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';
import { ADDRESS } from '../../exports/address.config';
import { Address, zeroAddress } from 'viem';
import { mainnet } from 'viem/chains';

// config and select
export const NAME: string = 'ZapperSwapEnsoV1'; // <-- select smart contract
export const FILE: string = 'ZapperSwapEnsoV1'; // <-- name exported file
export const MOD: string = NAME + 'Module';
console.log(NAME);

// params
export type DeploymentParams = {
	ensoRouter: Address;
	hopTargets: Address[];
};

const addr = ADDRESS[mainnet.id];

// ZapperSwapEnsoV1 has no owner: the Enso router and the hop targets are final once deployed, and a change (including a
// new Enso router version) means deploying a new zapper.
export const params: DeploymentParams = {
	// The only target of Call steps, which receive caller-supplied calldata. NEVER a token or anything else that can
	// move funds on behalf of the zapper, such as a vault share or Curve LP token. Do not copy it from docs: Enso ships
	// new router versions and advises using the `tx.to` of a live /shortcuts/route response, so take it from a real
	// quote and verify the contract on Etherscan before deploying. This one matched the `tx.to` of a live quote
	// (2026-11-02), has code and is not an EIP-1967 proxy; re-check before a later deployment.
	ensoRouter: '0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf',
	// Typed hops, only ever called with the zapper's own balances and itself as receiver
	hopTargets: [
		// swap routers
		addr.usduSwapRouterV1,
		addr.euruSwapRouterV1,
		addr.chfuSwapRouterV1,
		// reward vaults (rUSDU, rEURU, rCHFU)
		addr.usduStreamerVaultV1,
		addr.euruStreamerVaultV1,
		addr.chfuStreamerVaultV1,
		// Curve pools
		addr.curveStableSwapNG_USDCUSDU,
		addr.curveTwocryptoNG_USDUEURU,
		addr.curveTwocryptoNG_USDUCHFU,
	],
};

// the router cannot be changed later, so do not deploy with a placeholder
if (params.ensoRouter === zeroAddress) {
	throw new Error('ZapperSwapEnsoV1: set ensoRouter (from a live quote tx.to) before generating args or deploying');
}

export type ConstructorArgs = [Address, Address[]];

export const args: ConstructorArgs = [params.ensoRouter, params.hopTargets];

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
