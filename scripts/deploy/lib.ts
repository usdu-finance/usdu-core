/**
 * Shared helpers for the deploy scripts in this directory: network resolution (positional CLI arg, defaults
 * to mainnet), a wallet built from PRIVATE_KEY, and CREATE2 deployment through the canonical deterministic-
 * deployment-proxy so re-running a script with the same contract + constructor args always predicts (and, if
 * already deployed, resolves to) the same address rather than a fresh nonce-based one.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import { arbitrum, base, citrea, mainnet } from 'viem/chains';

// ---------------------------------------------------------------------------------------

export const CHAINS = { mainnet, arbitrum, base, citrea } as const;
export type Network = keyof typeof CHAINS;

const RPC_URLS: { [K in Network]: (alchemyKey: string) => string } = {
	mainnet: (key) => `https://eth-mainnet.g.alchemy.com/v2/${key}`,
	arbitrum: (key) => `https://arb-mainnet.g.alchemy.com/v2/${key}`,
	base: (key) => `https://base-mainnet.g.alchemy.com/v2/${key}`,
	citrea: () => `https://rpc.mainnet.citrea.xyz`,
};

// Canonical "Nick's method" deterministic-deployment-proxy — permissionless, same address on almost every
// EVM chain. Accepts calldata = 32-byte salt ++ init code, and CREATE2-deploys it.
export const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

// Static, protocol-wide addresses — hardcoded rather than pulled from exports/address.config.ts, since that
// module's per-network type doesn't guarantee every field exists on every chain and these deploy scripts
// should show exactly what address they're about to wire in, at a glance, without an extra lookup.
export const USDU_STABLE_BY_NETWORK: Partial<Record<Network, string>> = {
	mainnet: '0xdde3ec717f220fc6a29d6a4be73f91da5b718e55',
};

// ---------------------------------------------------------------------------------------

/**
 * Parses `npx tsx <script> [network] [true]` — network defaults to mainnet if omitted, `true` (only
 * meaningful as the last arg) switches from dry-run to broadcasting.
 */
export function resolveArgs(argv: string[]): { network: Network; execute: boolean } {
	const args = argv.slice(2);
	const execute = args[args.length - 1] === 'true';
	const networkArgs = execute ? args.slice(0, -1) : args;

	const requested = networkArgs[0];
	if (requested && !(requested in CHAINS)) {
		throw new Error(`Unknown network "${requested}" — expected one of: ${Object.keys(CHAINS).join(', ')}`);
	}

	return { network: (requested ?? 'mainnet') as Network, execute };
}

export function getProvider(network: Network): ethers.JsonRpcProvider {
	const alchemyKey = process.env.ALCHEMY_RPC_KEY;
	if (!alchemyKey && network !== 'citrea') throw new Error('Missing ALCHEMY_RPC_KEY in .env');
	return new ethers.JsonRpcProvider(RPC_URLS[network](alchemyKey ?? ''));
}

export function getWallet(provider: ethers.JsonRpcProvider): ethers.Wallet {
	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey) throw new Error('Missing PRIVATE_KEY in .env');
	if (!ethers.isHexString(privateKey, 32)) {
		throw new Error('PRIVATE_KEY in .env is not a valid 32-byte hex string — looks like the .env.example placeholder is still in place.');
	}
	return new ethers.Wallet(privateKey, provider);
}

/** Loads a Hardhat artifact's ABI + bytecode directly, so these scripts don't depend on the typechain barrel. */
export function loadArtifact(contractPath: string, contractName: string): { abi: ethers.InterfaceAbi; bytecode: string } {
	const artifactPath = join(__dirname, '../../artifacts', contractPath, `${contractName}.json`);
	const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
	return { abi: artifact.abi, bytecode: artifact.bytecode };
}

export function predictCreate2Address(bytecode: string, encodedArgs: string, salt: string): string {
	const initCode = ethers.concat([bytecode, encodedArgs]);
	return ethers.getCreate2Address(CREATE2_FACTORY, salt, ethers.keccak256(initCode));
}

export async function ensureFactoryDeployed(provider: ethers.JsonRpcProvider): Promise<void> {
	const code = await provider.getCode(CREATE2_FACTORY);
	if (code === '0x') throw new Error(`CREATE2 factory not deployed at ${CREATE2_FACTORY} on this network.`);
}

/**
 * Deploys `bytecode` (with ABI-encoded constructor args already appended) via the CREATE2 factory, using a
 * fixed `salt` — same contract + same args + same salt always predicts (and resolves to) the same address.
 * Returns the predicted address and whether it was already deployed (in which case nothing is sent).
 */
export async function deployViaCreate2(
	wallet: ethers.Wallet,
	provider: ethers.JsonRpcProvider,
	bytecode: string,
	encodedArgs: string,
	salt: string,
	execute: boolean
): Promise<{ address: string; alreadyDeployed: boolean }> {
	await ensureFactoryDeployed(provider);

	const initCode = ethers.concat([bytecode, encodedArgs]);
	const address = ethers.getCreate2Address(CREATE2_FACTORY, salt, ethers.keccak256(initCode));

	const existingCode = await provider.getCode(address);
	if (existingCode !== '0x') return { address, alreadyDeployed: true };

	const data = ethers.concat([salt, initCode]);

	// simulate first — reverts here mean the real broadcast would too, dry run or not
	try {
		await provider.call({ from: wallet.address, to: CREATE2_FACTORY, data });
	} catch (error) {
		// ethers' CallExceptionError.message embeds the full raw transaction — shortMessage is the human part
		const reason = (error as { shortMessage?: string })?.shortMessage ?? (error instanceof Error ? error.message : String(error));
		throw new Error(`Simulation reverted — the real deployment would fail too. Reason: ${reason}`);
	}

	if (!execute) return { address, alreadyDeployed: false };

	console.log('');
	console.log('Broadcasting in 5 seconds — Ctrl+C to cancel...');
	await new Promise((resolve) => setTimeout(resolve, 5_000));

	const tx = await wallet.sendTransaction({ to: CREATE2_FACTORY, data });
	console.log('Tx sent:        ', tx.hash);
	await tx.wait();

	return { address, alreadyDeployed: false };
}
