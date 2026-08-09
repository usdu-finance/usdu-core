/**
 * Deploys SwapBridgeMorphoV1 — a stablecoin bridge for a trusted source coin (e.g. USDC) into an ERC4626
 * vault (e.g. a Morpho Vault V2). See contracts/swap/morpho/SwapBridgeMorphoV1.sol for the full mechanics.
 *
 * Deployed via CREATE2 through the canonical deterministic-deployment-proxy, with a fixed salt. Since the
 * CREATE2 address also depends on the init code (bytecode + constructor args), the same salt is safe to reuse
 * across genuinely different deployments (a different vault, a different coin, ...) — each combination of
 * args still predicts its own distinct address; only an exact re-run (same network, same args) resolves to
 * the same, already-deployed address.
 *
 * Usage:
 *   npx tsx scripts/deploy/SwapBridgeMorphoV1.ts [network] [true]
 *
 *   (no args)   Dry run against mainnet: predict the address, simulate, print the plan.
 *   network     One of: mainnet, arbitrum, base, citrea (defaults to mainnet if omitted).
 *   true        Must be the last arg. Also broadcasts the deployment transaction.
 *
 * Examples:
 *   npx tsx scripts/deploy/SwapBridgeMorphoV1.ts                 # dry run, mainnet
 *   npx tsx scripts/deploy/SwapBridgeMorphoV1.ts arbitrum         # dry run, arbitrum
 *   npx tsx scripts/deploy/SwapBridgeMorphoV1.ts true             # execute, mainnet
 *   npx tsx scripts/deploy/SwapBridgeMorphoV1.ts arbitrum true    # execute, arbitrum
 *
 * Env:
 *   PRIVATE_KEY      - deployer's private key (required)
 *   ALCHEMY_RPC_KEY  - Alchemy API key for the target network's RPC endpoint (required, except on citrea)
 *
 * Args (constructor args for SwapBridgeMorphoV1 — set in CONFIG below, not passed via CLI):
 *   stable        - address of the IStablecoin this bridge mints/burns. Taken from USDU_STABLE_BY_NETWORK
 *                   in lib.ts for the selected network.
 *   coin          - the source coin this bridge accepts (e.g. USDC). Defaults to mainnet USDC.
 *   vault         - the ERC4626 vault the coin is deposited into (e.g. a Morpho Vault V2). NO DEFAULT — this
 *                   is deployment-specific and MUST be set below before running with `true`.
 *   mintCap       - max stablecoin this bridge may mint against new deposits (18 decimals). Review before deploying.
 *   swapInFeePPM  - fee for swapping coin into stablecoin, in parts per million (1_000_000 = 100%).
 *   swapOutFeePPM - fee for swapping stablecoin back into coin, in parts per million.
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
// CONFIG — review every value below before running with `true`

const SALT = ethers.id('usdu-finance/SwapBridgeMorphoV1');

const CONFIG = {
	// the source coin this bridge accepts — defaults to mainnet USDC, override for other networks/coins
	coin: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',

	// the ERC4626 vault (e.g. a Morpho Vault V2) the coin is deposited into — NO SAFE DEFAULT, must be set
	vault: ethers.ZeroAddress,

	// max stablecoin this bridge may mint against new deposits (18 decimals) — start conservative
	mintCap: ethers.parseEther('100000'),

	// swap-in fee: coin -> stablecoin, in parts per million (5_000 = 0.5%)
	swapInFeePPM: 5_000n,

	// swap-out fee: stablecoin -> coin, in parts per million (3_000 = 0.3%)
	swapOutFeePPM: 3_000n,
};

// ---------------------------------------------------------------------------------------

async function main() {
	const { network, execute } = resolveArgs(process.argv);
	const chain = CHAINS[network];

	const stable = USDU_STABLE_BY_NETWORK[network];
	if (!stable) throw new Error(`No usduStable configured for network "${network}". Set USDU_STABLE_BY_NETWORK in lib.ts.`);
	if (CONFIG.vault === ethers.ZeroAddress) {
		throw new Error('CONFIG.vault is still the zero-address placeholder — set the target ERC4626 vault before deploying.');
	}

	const provider = getProvider(network);
	const wallet = getWallet(provider);

	const { abi, bytecode } = loadArtifact('contracts/swap/morpho/SwapBridgeMorphoV1.sol', 'SwapBridgeMorphoV1');
	const args = [stable, CONFIG.coin, CONFIG.vault, CONFIG.mintCap, CONFIG.swapInFeePPM, CONFIG.swapOutFeePPM] as const;
	const encodedArgs = new ethers.Interface(abi).encodeDeploy(args);
	const predictedAddress = predictCreate2Address(bytecode, encodedArgs, SALT);

	console.log('### SwapBridgeMorphoV1 deployment ###');
	console.log('Network:        ', network, `(chainId ${chain.id})`);
	console.log('Deployer:       ', wallet.address);
	console.log('Deployer ETH:   ', ethers.formatEther(await provider.getBalance(wallet.address)));
	console.log('Mode:           ', execute ? 'EXECUTE (will broadcast)' : 'DRY RUN (no transaction sent)');
	console.log('Salt:           ', SALT);
	console.log('Predicted addr: ', predictedAddress);
	console.log('');
	console.log('Constructor args:');
	console.log('  stable:       ', stable);
	console.log('  coin:         ', CONFIG.coin);
	console.log('  vault:        ', CONFIG.vault);
	console.log('  mintCap:      ', ethers.formatEther(CONFIG.mintCap));
	console.log('  swapInFeePPM: ', CONFIG.swapInFeePPM.toString(), `(${Number(CONFIG.swapInFeePPM) / 10_000}%)`);
	console.log('  swapOutFeePPM:', CONFIG.swapOutFeePPM.toString(), `(${Number(CONFIG.swapOutFeePPM) / 10_000}%)`);
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
	console.log('SwapBridgeMorphoV1:', address);
	console.log('');
	console.log('Verify with:');
	console.log(`  npx hardhat verify --network ${network} ${address} ${args.map((a) => a.toString()).join(' ')}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
