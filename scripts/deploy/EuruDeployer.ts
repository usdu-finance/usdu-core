/**
 * Deploys EuruDeployer — a one-shot deployer contract whose constructor, in a single transaction:
 *   1. mints the EURU Stablecoin
 *   2. deploys SwapRouterV1, the generic swap entrypoint, wired to it
 *   3. deploys SwapBridgeMorphoV1 against the given vault and registers it as a module on the stablecoin
 *   4. hands curatorship over to the DAO (curator accepts the role in a second, separate step:
 *      EuruDeployer.stable() then Stablecoin.acceptCurator() from the DAO)
 *
 * EURU is mainnet-only for now, so this script doesn't take a network arg — everything below always targets
 * mainnet.
 *
 * A second vault (e.g. a different EURC/EURO market) is added later, independently, via
 * `npx tsx scripts/deploy/SwapBridgeMorphoV1.ts euru <vault> [true]` against the already-deployed EURU stable.
 *
 * Deployed via CREATE2 through the canonical deterministic-deployment-proxy, with a fixed salt: re-running
 * this script for the same vault always predicts — and, if already deployed, resolves to — the same address,
 * rather than a fresh nonce-based one.
 *
 * Usage:
 *   npx tsx scripts/deploy/EuruDeployer.ts <vault> [true]
 *
 *   vault   Required. Address of the ERC4626 vault (e.g. a Morpho Vault V2) the bundled SwapBridgeMorphoV1
 *           module deploys against.
 *   true    Must be the last arg. Also broadcasts the deployment transaction.
 *
 * Examples:
 *   npx tsx scripts/deploy/EuruDeployer.ts 0xVault...          # dry run
 *   npx tsx scripts/deploy/EuruDeployer.ts 0xVault... true     # execute
 *
 * Env:
 *   PRIVATE_KEY      - deployer's private key (required)
 *   ALCHEMY_RPC_KEY  - Alchemy API key for mainnet's RPC endpoint (required)
 *
 * Args (constructor args for EuruDeployer — resolved below, not passed via CLI):
 *   curator       - address the EURU Stablecoin's curatorship is handed to. Taken from DAO_BY_NETWORK.mainnet
 *                   in lib.ts.
 *   distributor   - Merkl's Distributor contract, for claiming incentives accrued on the vault position.
 *                   Taken from MERKL_DISTRIBUTOR_BY_NETWORK.mainnet in lib.ts.
 *   vault         - the ERC4626 vault the coin is deposited into. Passed as the CLI <vault> arg above.
 *   mintCap       - max stablecoin the bundled bridge may mint against new deposits (18 decimals). Set in
 *                   CONFIG below — review before deploying.
 *   swapInFeePPM  - fee for swapping coin into stablecoin, in parts per million (1_000_000 = 100%). Set in CONFIG.
 *   swapOutFeePPM - fee for swapping stablecoin back into coin, in parts per million. Set in CONFIG.
 */

import 'dotenv/config';
import { ethers } from 'ethers';

import {
	DAO_BY_NETWORK,
	MERKL_DISTRIBUTOR_BY_NETWORK,
	deployViaCreate2,
	getERC20Details,
	getERC4626Details,
	getProvider,
	getWallet,
	loadArtifact,
	predictCreate2Address,
	resolveMainnetArgsWithAddress,
} from './lib';

// ---------------------------------------------------------------------------------------
// CONFIG — review every value below before running with `true`

const SALT = ethers.id('usdu-finance/EuruDeployer');

const CONFIG = {
	// max stablecoin the bundled bridge may mint against new deposits (18 decimals) — start conservative
	mintCap: ethers.parseEther('80') * 1_000n,

	// swap-in fee: coin -> stablecoin, in parts per million (e.g. 1_000 = 0.1%)
	swapInFeePPM: 1_000n,

	// swap-out fee: stablecoin -> coin, in parts per million (e.g. 1_000 = 0.1%)
	swapOutFeePPM: 1_000n,
};

// ---------------------------------------------------------------------------------------

async function main() {
	const { address: vaultAddress, execute } = resolveMainnetArgsWithAddress(process.argv, 'vault');

	const curator = DAO_BY_NETWORK.mainnet;
	if (!curator) throw new Error('No DAO configured for mainnet. Set DAO_BY_NETWORK.mainnet in lib.ts.');

	const distributor = MERKL_DISTRIBUTOR_BY_NETWORK.mainnet;
	if (!distributor) throw new Error('No Merkl distributor configured for mainnet. Set MERKL_DISTRIBUTOR_BY_NETWORK.mainnet in lib.ts.');

	const provider = getProvider('mainnet');
	const wallet = getWallet(provider);

	console.log('### EuruDeployer deployment ###');
	console.log('Network:        mainnet');
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

	const { abi, bytecode } = loadArtifact('contracts/deploy/EuruDeployer.sol', 'EuruDeployer');
	const args = [curator, distributor, vaultAddress, CONFIG.mintCap, CONFIG.swapInFeePPM, CONFIG.swapOutFeePPM] as const;
	const encodedArgs = new ethers.Interface(abi).encodeDeploy(args);
	const predictedAddress = predictCreate2Address(bytecode, encodedArgs, SALT);

	console.log('Salt:           ', SALT);
	console.log('Predicted addr: ', predictedAddress);
	console.log('');
	console.log('Constructor args:');
	console.log('  curator:      ', curator, '(DAO)');
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

	const euruDeployer = new ethers.Contract(address, abi, wallet);
	const [stable, router, bridge] = await Promise.all([euruDeployer.stable(), euruDeployer.router(), euruDeployer.bridge()]);

	console.log('');
	console.log('### Deployed ###');
	console.log('EuruDeployer:   ', address);
	console.log('EURU Stable:    ', stable);
	console.log('SwapRouterV1:   ', router);
	console.log('SwapBridgeMorphoV1:', bridge);
	console.log('');
	console.log('Next step: have the DAO call Stablecoin.acceptCurator() on the EURU stable to accept curatorship.');
	console.log('');
	console.log('Verify with:');
	console.log(`  npx hardhat verify --network mainnet ${address} ${args.map((a) => a.toString()).join(' ')}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
