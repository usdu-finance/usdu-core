/**
 * Deploys SwapRouterV1 — the stateless, non-custodial entrypoint that forwards swapIn/swapOut calls to
 * whichever ISwapBridgeV1 module is registered on the configured stablecoin.
 *
 * Deployed via CREATE2 through the canonical deterministic-deployment-proxy, with a fixed salt: re-running
 * this script for the same network always predicts — and, if already deployed, resolves to — the same
 * address, rather than a fresh nonce-based one.
 *
 * Usage:
 *   npx tsx scripts/deploy/SwapRouterV1.ts [network] [true]
 *
 *   (no args)   Dry run against mainnet: predict the address, simulate, print the plan.
 *   network     One of: mainnet, arbitrum, base, citrea (defaults to mainnet if omitted).
 *   true        Must be the last arg. Also broadcasts the deployment transaction.
 *
 * Examples:
 *   npx tsx scripts/deploy/SwapRouterV1.ts                 # dry run, mainnet
 *   npx tsx scripts/deploy/SwapRouterV1.ts arbitrum         # dry run, arbitrum
 *   npx tsx scripts/deploy/SwapRouterV1.ts true             # execute, mainnet
 *   npx tsx scripts/deploy/SwapRouterV1.ts arbitrum true    # execute, arbitrum
 *
 * Env:
 *   PRIVATE_KEY      - deployer's private key (required)
 *   ALCHEMY_RPC_KEY  - Alchemy API key for the target network's RPC endpoint (required, except on citrea)
 *
 * Args (constructor args for SwapRouterV1 — resolved below, not passed via CLI):
 *   stable  - address of the IStablecoin whose registered modules this router forwards calls to.
 *             Taken from USDU_STABLE_BY_NETWORK in lib.ts for the selected network.
 */

import 'dotenv/config';
import { ethers } from 'ethers';

import {
	CHAINS,
	USDU_STABLE_BY_NETWORK,
	deployViaCreate2,
	getProvider,
	getWallet,
	loadArtifact,
	predictCreate2Address,
	resolveArgs,
} from './lib';

// ---------------------------------------------------------------------------------------
// CONFIG — review before running with `true`

// Fixed (not random): SwapRouterV1 is a persistent singleton per network, not single-use, so re-running this
// script should keep predicting the same address rather than a new one each time.
const SALT = ethers.id('usdu-finance/SwapRouterV1');

// ---------------------------------------------------------------------------------------

async function main() {
	const { network, execute } = resolveArgs(process.argv);
	const chain = CHAINS[network];

	const stable = USDU_STABLE_BY_NETWORK[network];
	if (!stable) throw new Error(`No usduStable configured for network "${network}". Set USDU_STABLE_BY_NETWORK in lib.ts.`);

	const provider = getProvider(network);
	const wallet = getWallet(provider);

	const { abi, bytecode } = loadArtifact('contracts/swap/router/SwapRouterV1.sol', 'SwapRouterV1');
	const encodedArgs = new ethers.Interface(abi).encodeDeploy([stable]);
	const predictedAddress = predictCreate2Address(bytecode, encodedArgs, SALT);

	console.log('### SwapRouterV1 deployment ###');
	console.log('Network:        ', network, `(chainId ${chain.id})`);
	console.log('Deployer:       ', wallet.address);
	console.log('Deployer ETH:   ', ethers.formatEther(await provider.getBalance(wallet.address)));
	console.log('Mode:           ', execute ? 'EXECUTE (will broadcast)' : 'DRY RUN (no transaction sent)');
	console.log('Salt:           ', SALT);
	console.log('Predicted addr: ', predictedAddress);
	console.log('');
	console.log('Constructor args:');
	console.log('  stable:       ', stable);
	console.log('');

	const { address, alreadyDeployed } = await deployViaCreate2(wallet, provider, bytecode, encodedArgs, SALT, execute);

	if (alreadyDeployed) {
		console.log(`Already deployed at ${address} — nothing to do.`);
		return;
	}

	if (!execute) {
		console.log('Simulation succeeded. Dry run only — rerun with `true` as the last argument to broadcast.');
		return;
	}

	console.log('');
	console.log('### Deployed ###');
	console.log('SwapRouterV1:   ', address);
	console.log('');
	console.log('Verify with:');
	console.log(`  npx hardhat verify --network ${network} ${address} ${stable}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
