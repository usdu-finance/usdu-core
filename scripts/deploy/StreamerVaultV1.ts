/**
 * Deploys StreamerVaultV1 — an ERC-4626 rewards streamer for a stablecoin (e.g. USDU). Stakers deposit the coin
 * and receive shares; protocol rewards are sent to the vault as a plain ERC20 transfer and then streamed
 * linearly to the stakers over `duration` (picked up by sync(), which deposit/withdraw also trigger).
 *
 * Deployed via CREATE2 through the canonical deterministic-deployment-proxy, with a fixed salt. Since the
 * CREATE2 address also depends on the init code (bytecode + constructor args), the same salt is safe to reuse
 * across coins and networks — each combination of args still predicts its own distinct address.
 *
 * Usage:
 *   npx tsx scripts/deploy/StreamerVaultV1.ts <coin> [network] [true]
 *
 *   coin        Required. Which stablecoin is staked and streamed: usdu | euru | chfu.
 *   network     One of: mainnet, arbitrum, base, optimism, polygon (defaults to mainnet if omitted).
 *   true        Must be the last arg. Also broadcasts the deployment transaction.
 *
 * Examples:
 *   npx tsx scripts/deploy/StreamerVaultV1.ts usdu                 # dry run, mainnet
 *   npx tsx scripts/deploy/StreamerVaultV1.ts usdu true            # execute, mainnet
 *
 * Env:
 *   PRIVATE_KEY      - deployer's private key (required)
 *   ALCHEMY_RPC_KEY  - Alchemy API key for the target network's RPC endpoint (required)
 *
 * Args (constructor args for StreamerVaultV1):
 *   asset     - the stablecoin staked and streamed. Taken from STABLE_BY_NETWORK in lib.ts.
 *   duration  - seconds over which funded rewards are streamed. Set in CONFIG below — review before deploying.
 *   name      - ERC20 name of the share token. Set in CONFIG.
 *   symbol    - ERC20 symbol of the share token. Set in CONFIG.
 */

import 'dotenv/config';
import { ethers } from 'ethers';

import {
	CHAINS,
	STABLE_BY_NETWORK,
	deployViaCreate2,
	getERC20Details,
	getProvider,
	getWallet,
	loadArtifact,
	predictCreate2Address,
	resolveArgsWithCoin,
} from './lib';

// ---------------------------------------------------------------------------------------
// CONFIG — review every value below before running with `true`

const SALT = ethers.id('usdu-finance/StreamerVaultV1');

const CONFIG = {
	// stream length for every funded amount: 90 days
	duration: 90n * 24n * 60n * 60n,
};

// ---------------------------------------------------------------------------------------

async function main() {
	const { coin, network, execute } = resolveArgsWithCoin(process.argv);
	const chain = CHAINS[network];

	const asset = STABLE_BY_NETWORK[coin][network];
	if (!asset) throw new Error(`No ${coin} stable configured for network "${network}". Set STABLE_BY_NETWORK.${coin} in lib.ts.`);

	const provider = getProvider(network);
	const wallet = getWallet(provider);
	const assetInfo = await getERC20Details(provider, asset);

	const name = `${assetInfo.symbol} Rewards Streamer`;
	const symbol = `str${assetInfo.symbol}`;

	console.log('### StreamerVaultV1 deployment ###');
	console.log('Coin:           ', coin);
	console.log('Network:        ', network, `(chainId ${chain.id})`);
	console.log('Deployer:       ', wallet.address);
	console.log('Deployer ETH:   ', ethers.formatEther(await provider.getBalance(wallet.address)));
	console.log('Mode:           ', execute ? 'EXECUTE (will broadcast)' : 'DRY RUN (no transaction sent)');
	console.log('');
	console.log('Asset:');
	console.log('  address:      ', assetInfo.address);
	console.log('  symbol:       ', assetInfo.symbol);
	console.log('  decimals:     ', assetInfo.decimals.toString());
	console.log('');

	const { abi, bytecode } = loadArtifact('contracts/streamer/StreamerVaultV1.sol', 'StreamerVaultV1');
	const args = [asset, CONFIG.duration, name, symbol] as const;
	const encodedArgs = new ethers.Interface(abi).encodeDeploy(args);
	const predictedAddress = predictCreate2Address(bytecode, encodedArgs, SALT);

	console.log('Salt:           ', SALT);
	console.log('Predicted addr: ', predictedAddress);
	console.log('');
	console.log('Constructor args:');
	console.log('  asset:        ', asset);
	console.log('  duration:     ', CONFIG.duration.toString(), `(${Number(CONFIG.duration) / 86_400} days)`);
	console.log('  name:         ', name);
	console.log('  symbol:       ', symbol);
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
	console.log('StreamerVaultV1:', address);
	console.log('');
	console.log('Verify with:');
	console.log(`  npx hardhat verify --network ${network} ${address} ${args.map((a) => a.toString()).join(' ')}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
