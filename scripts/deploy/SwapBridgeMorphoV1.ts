/**
 * Deploys SwapBridgeMorphoV1 — a stablecoin bridge for a trusted source coin (e.g. USDC) into an ERC4626
 * vault (e.g. a Morpho Vault V2). The coin is derived on-chain from vault.asset() (not a separate arg), so
 * this script introspects and prints the vault's own details — and its underlying coin's — before deploying
 * against it, to make it obvious exactly what's being wired in.
 *
 * Deployed via CREATE2 through the canonical deterministic-deployment-proxy, with a fixed salt. Since the
 * CREATE2 address also depends on the init code (bytecode + constructor args), the same salt is safe to reuse
 * across genuinely different deployments (a different vault, ...) — each combination of args still predicts
 * its own distinct address; only an exact re-run (same network, same vault) resolves to the same,
 * already-deployed address.
 *
 * Usage:
 *   npx tsx scripts/deploy/SwapBridgeMorphoV1.ts <vault> [network] [true]
 *
 *   vault       Required. Address of the ERC4626 vault (e.g. a Morpho Vault V2) to deploy against.
 *   network     One of: mainnet, arbitrum, base, citrea (defaults to mainnet if omitted).
 *   true        Must be the last arg. Also broadcasts the deployment transaction.
 *
 * Examples:
 *   npx tsx scripts/deploy/SwapBridgeMorphoV1.ts 0xVault...                 # dry run, mainnet
 *   npx tsx scripts/deploy/SwapBridgeMorphoV1.ts 0xVault... arbitrum        # dry run, arbitrum
 *   npx tsx scripts/deploy/SwapBridgeMorphoV1.ts 0xVault... true            # execute, mainnet
 *   npx tsx scripts/deploy/SwapBridgeMorphoV1.ts 0xVault... arbitrum true   # execute, arbitrum
 *
 * Env:
 *   PRIVATE_KEY      - deployer's private key (required)
 *   ALCHEMY_RPC_KEY  - Alchemy API key for the target network's RPC endpoint (required, except on citrea)
 *
 * Args (constructor args for SwapBridgeMorphoV1):
 *   stable        - address of the IStablecoin this bridge mints/burns. Taken from USDU_STABLE_BY_NETWORK
 *                   in lib.ts for the selected network.
 *   distributor   - Merkl's Distributor contract, for claiming incentives accrued on the vault position.
 *                   Taken from MERKL_DISTRIBUTOR_BY_NETWORK in lib.ts for the selected network.
 *   vault         - the ERC4626 vault the coin is deposited into. Passed as the CLI <vault> arg above.
 *   mintCap       - max stablecoin this bridge may mint against new deposits (18 decimals). Set in CONFIG
 *                   below — review before deploying.
 *   swapInFeePPM  - fee for swapping coin into stablecoin, in parts per million (1_000_000 = 100%). Set in CONFIG.
 *   swapOutFeePPM - fee for swapping stablecoin back into coin, in parts per million. Set in CONFIG.
 */

import 'dotenv/config';
import { ethers } from 'ethers';

import {
	CHAINS,
	MERKL_DISTRIBUTOR_BY_NETWORK,
	USDU_STABLE_BY_NETWORK,
	deployViaCreate2,
	getERC20Details,
	getERC4626Details,
	getProvider,
	getWallet,
	loadArtifact,
	predictCreate2Address,
	resolveArgsWithAddress,
} from './lib';

// ---------------------------------------------------------------------------------------
// CONFIG — review every value below before running with `true`

const SALT = ethers.id('usdu-finance/SwapBridgeMorphoV1');

const CONFIG = {
	// max stablecoin this bridge may mint against new deposits (18 decimals) — start conservative
	mintCap: ethers.parseEther('0.1') * 1_000_000n,

	// swap-in fee: coin -> stablecoin, in parts per million (e.g. 3_000 = 0.3%)
	swapInFeePPM: 1_000n,

	// swap-out fee: stablecoin -> coin, in parts per million (e.g. 3_000 = 0.3%)
	swapOutFeePPM: 1_000n,
};

// ---------------------------------------------------------------------------------------

async function main() {
	const { address: vaultAddress, network, execute } = resolveArgsWithAddress(process.argv, 'vault');
	const chain = CHAINS[network];

	const stable = USDU_STABLE_BY_NETWORK[network];
	if (!stable) throw new Error(`No usduStable configured for network "${network}". Set USDU_STABLE_BY_NETWORK in lib.ts.`);

	const distributor = MERKL_DISTRIBUTOR_BY_NETWORK[network];
	if (!distributor)
		throw new Error(`No Merkl distributor configured for network "${network}". Set MERKL_DISTRIBUTOR_BY_NETWORK in lib.ts.`);

	const provider = getProvider(network);
	const wallet = getWallet(provider);

	console.log('### SwapBridgeMorphoV1 deployment ###');
	console.log('Network:        ', network, `(chainId ${chain.id})`);
	console.log('Deployer:       ', wallet.address);
	console.log('Deployer ETH:   ', ethers.formatEther(await provider.getBalance(wallet.address)));
	console.log('Mode:           ', execute ? 'EXECUTE (will broadcast)' : 'DRY RUN (no transaction sent)');
	console.log('');

	// ── Introspect the vault + its underlying coin before wiring anything in ──────────────
	const vaultInfo = await getERC4626Details(provider, vaultAddress);
	const coinInfo = await getERC20Details(provider, vaultInfo.asset);

	console.log('Vault:');
	console.log('  address:      ', vaultInfo.address);
	console.log('  name:         ', vaultInfo.name);
	console.log('  symbol:       ', vaultInfo.symbol);
	console.log('  decimals:     ', vaultInfo.decimals.toString());
	console.log('  totalAssets:  ', ethers.formatUnits(vaultInfo.totalAssets, coinInfo.decimals), coinInfo.symbol);
	console.log('  totalSupply:  ', ethers.formatUnits(vaultInfo.totalSupply, vaultInfo.decimals), vaultInfo.symbol);
	console.log('');
	console.log('Coin (vault.asset()):');
	console.log('  address:      ', coinInfo.address);
	console.log('  name:         ', coinInfo.name);
	console.log('  symbol:       ', coinInfo.symbol);
	console.log('  decimals:     ', coinInfo.decimals.toString());
	console.log('');

	const { abi, bytecode } = loadArtifact('contracts/swap/morpho/SwapBridgeMorphoV1.sol', 'SwapBridgeMorphoV1');
	const args = [stable, distributor, vaultAddress, CONFIG.mintCap, CONFIG.swapInFeePPM, CONFIG.swapOutFeePPM] as const;
	const encodedArgs = new ethers.Interface(abi).encodeDeploy(args);
	const predictedAddress = predictCreate2Address(bytecode, encodedArgs, SALT);

	console.log('Salt:           ', SALT);
	console.log('Predicted addr: ', predictedAddress);
	console.log('');
	console.log('Constructor args:');
	console.log('  stable:       ', stable);
	console.log('  distributor:  ', distributor);
	console.log('  vault:        ', vaultAddress);
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
