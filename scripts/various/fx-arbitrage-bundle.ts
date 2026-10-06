import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { ADDRESS } from '../../exports/address.config';

dotenv.config();

// Private bundle (same builder fan-out as frankencoin-bid.ts) with two transactions from SIGNER:
//
//   nonce     execute the DAO payload DCIP-16 (AragonDelayedAction.execute(proposalId)): accepts the
//             CurveSeedAdapterV1 module on USDU/EURU/CHFU and seeds the USDU/EURU + USDU/CHFU pools
//             at their stale price_scale
//   nonce + 1 FxArbitrageEuruV1.execute(): Morpho EURC flash loan -> bridge -> USDU/EURU pool ->
//             USDC/USDU pool -> Uniswap -> EURC, reverts below MIN_PROFIT
//
// Both land in the same block or not at all: if the payload is executed by someone else first (or the arb is
// no longer profitable at MIN_PROFIT) a tx in the bundle reverts and builders drop the whole bundle.
//
//   npx ts-node scripts/various/fx-arbitrage-bundle.ts          read-only: checks + prints the plan
//   npx ts-node scripts/various/fx-arbitrage-bundle.ts true     broadcast
//   npx ts-node scripts/various/fx-arbitrage-bundle.ts cancel   cancel pending bundles (uuid-capable builders)

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const SIGNER = '0x0170F42f224b99CcbbeE673093589c5f9691dd06';

// Aragon DAO plugin holding the DCIP-16 proposal, and its onchain proposal id
const DELAYED_ACTION = ADDRESS[1].aragonDelayedAction;
const PROPOSAL_ID = 86556343630672508522658538266021539186885073574342444569249268028717067257335n;

// FxArbitrageEuruV1 deployment (owner must be SIGNER), deployed via ignition
const FX_ARB: string = '0x58E169A5019B1DB1Df97509c1E46e943f4Ed23b2';

// Flash loan size in EURC (6 decimals). Fork test (100k-depth seed): profit peaks ~10k, 15k is already thin and
// >= 20k loses to slippage in the USDU/EURU pool.
const AMOUNT = ethers.parseUnits('10000', 6);

// Revert the arb (and so the bundle) if less EURC than this is left after repaying the loan
const MIN_PROFIT = ethers.parseUnits('50', 6);

// Uniswap v3 path USDC -[0.05%]-> EURC (the 0.05% pool holds ~600k USDC / ~1.67M EURC, the other tiers are empty)
const UNI_PATH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb480001f41abaea1f7c830bd89acc67ec4af516284b1bc33c';

const GAS_LIMIT_PAYLOAD = 2_500_000n; // 5 DAO actions incl. two ~400k-gas pool seeds
const GAS_LIMIT_ARB = 1_500_000n;

// Priority fee paid to block builders (per tx).
const PRIORITY_FEE = ethers.parseUnits('0.1', 'gwei');

const BLOCK_TIME = 12;

// The payload is executable now (not time-gated), so the window starts at the next block.
// Each offset gets its own UUID so it is independently cancellable.
export const BLOCK_OFFSETS = [0, 1, 2, 3, 4, 5];

export const BUNDLE_UUID = 'usdu-fx-arbitrage-dcip16';

export function bundleUuid(offset: number): string {
	return `${BUNDLE_UUID}+${offset}`;
}

// Builders to broadcast to in parallel. Flashbots requires a signed header; the others accept unauthenticated requests.
// Source: https://github.com/flashbots/dowg/blob/main/builder-registrations.json
// uuid: true  = supports cancel-endpoint (eth_cancelBundle by replacementUuid)
// uuid: false = no cancel-endpoint support (submit-only)
export const BUILDERS = [
	{ name: 'Titan', url: 'https://rpc.titanbuilder.xyz', auth: false, uuid: true },
	{ name: 'Flashbots', url: 'https://rpc.flashbots.net', auth: true, uuid: false },
	{ name: 'Beaver', url: 'https://mevshare-rpc.beaverbuild.org', auth: false, uuid: false },
	{ name: 'Eureka', url: 'https://rpc.eurekabuilder.xyz', auth: false, uuid: false },
	{ name: 'Quasar', url: 'https://rpc.quasar.win', auth: false, uuid: false },
	{ name: 'JetBuilder', url: 'https://rpc.mevshare.jetbldr.xyz', auth: false, uuid: false },
];

// ─────────────────────────────────────────────────────────────────────────────

const DELAYED_ACTION_IFACE = new ethers.Interface([
	'function execute(uint256 proposalId)',
	'function canExecute(uint256 proposalId) view returns (bool)',
]);
const ARB_IFACE = new ethers.Interface([
	'function execute(uint256 amount, bytes uniPath, uint256 minProfit) returns (uint256)',
	'function owner() view returns (address)',
]);
const POOL_ABI = ['function totalSupply() view returns (uint256)'];

// Flashbots signs the keccak256 hex string as text (not raw bytes)
async function flashbotsHeader(signer: ethers.Wallet, body: string): Promise<string> {
	const sig = await signer.signMessage(ethers.id(body));
	return `${signer.address}:${sig}`;
}

async function post(builder: (typeof BUILDERS)[number], signer: ethers.Wallet, body: string) {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (builder.auth) headers['X-Flashbots-Signature'] = await flashbotsHeader(signer, body);
	const res = await fetch(builder.url, { method: 'POST', headers, body });
	return (await res.json()) as { result?: unknown; error?: unknown };
}

const tag = (builder: (typeof BUILDERS)[number], offset: number) => `${builder.name.padEnd(10)} [+${offset}]`;

async function submitToBuilder(
	builder: (typeof BUILDERS)[number],
	signedTxs: string[],
	blockNumber: number,
	offset: number,
	signer: ethers.Wallet
) {
	const params: Record<string, unknown> = { txs: signedTxs, blockNumber: '0x' + blockNumber.toString(16) };
	if (builder.uuid) params.replacementUuid = bundleUuid(offset);

	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendBundle', params: [params] });
	try {
		const result = await post(builder, signer, body);
		console.log(`  ${tag(builder, offset)} ${result.error ? '✗  ' + JSON.stringify(result.error) : '✓'}`);
	} catch (err) {
		console.log(`  ${tag(builder, offset)} ✗  ${(err as Error).message}`);
	}
}

async function cancelAtBuilder(builder: (typeof BUILDERS)[number], offset: number, signer: ethers.Wallet) {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_cancelBundle', params: [{ replacementUuid: bundleUuid(offset) }] });
	try {
		const result = await post(builder, signer, body);
		console.log(`  ${tag(builder, offset)} ${result.error ? '✗  ' + JSON.stringify(result.error) : '✓ cancelled'}`);
	} catch (err) {
		console.log(`  ${tag(builder, offset)} ✗  ${(err as Error).message}`);
	}
}

async function main() {
	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey) throw new Error('PRIVATE_KEY not set in .env');

	const alchemy = process.env.ALCHEMY_RPC_KEY;
	if (!alchemy) throw new Error('ALCHEMY_RPC_KEY not set in .env');

	const provider = new ethers.JsonRpcProvider(`https://eth-mainnet.g.alchemy.com/v2/${alchemy}`);
	const signer = new ethers.Wallet(privateKey, provider);
	if (signer.address.toLowerCase() !== SIGNER.toLowerCase()) throw new Error(`PRIVATE_KEY is ${signer.address}, expected ${SIGNER}`);

	if (process.argv.includes('cancel')) {
		console.log('Cancelling bundles...');
		await Promise.all(BLOCK_OFFSETS.flatMap((o) => BUILDERS.filter((b) => b.uuid).map((b) => cancelAtBuilder(b, o, signer))));
		return;
	}

	// --- pre-flight checks ---------------------------------------------------------
	const hasArb = FX_ARB !== ethers.ZeroAddress && (await provider.getCode(FX_ARB)) !== '0x';
	if (!hasArb) throw new Error('FX_ARB is not set / has no code on mainnet: deploy FxArbitrageEuruV1 first and set FX_ARB');

	const [owner, canExecute, euruPoolSupply, chfuPoolSupply] = await Promise.all([
		new ethers.Contract(FX_ARB, ARB_IFACE, provider).owner(),
		new ethers.Contract(DELAYED_ACTION, DELAYED_ACTION_IFACE, provider).canExecute(PROPOSAL_ID),
		new ethers.Contract(ADDRESS[1].curveTwocryptoNG_USDUEURU, POOL_ABI, provider).totalSupply(),
		new ethers.Contract(ADDRESS[1].curveTwocryptoNG_USDUCHFU, POOL_ABI, provider).totalSupply(),
	]);
	if (owner.toLowerCase() !== SIGNER.toLowerCase()) throw new Error(`FX_ARB owner is ${owner}, expected ${SIGNER}`);
	if (euruPoolSupply > 0n || chfuPoolSupply > 0n) throw new Error('Pools are already seeded: DCIP-16 has been executed already');
	if (!canExecute) throw new Error('DCIP-16 is not executable (yet): AragonDelayedAction.canExecute() is false');

	const [latestBlock, nonce, feeData, balance] = await Promise.all([
		provider.getBlock('latest'),
		provider.getTransactionCount(signer.address),
		provider.getFeeData(),
		provider.getBalance(signer.address),
	]);
	if (!latestBlock) throw new Error('Could not fetch latest block');

	const targetBlock = latestBlock.number + 1;
	const maxFeePerGas = (feeData.maxFeePerGas ?? 0n) + PRIORITY_FEE;

	const base = { value: 0n, chainId: 1n, maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE, type: 2 } as const;

	const payloadTx: ethers.TransactionRequest = {
		...base,
		to: DELAYED_ACTION,
		data: DELAYED_ACTION_IFACE.encodeFunctionData('execute', [PROPOSAL_ID]),
		gasLimit: GAS_LIMIT_PAYLOAD,
		nonce,
	};
	const arbTx: ethers.TransactionRequest = {
		...base,
		to: FX_ARB,
		data: ARB_IFACE.encodeFunctionData('execute', [AMOUNT, UNI_PATH, MIN_PROFIT]),
		gasLimit: GAS_LIMIT_ARB,
		nonce: nonce + 1,
	};

	const signedTxs = [await signer.signTransaction(payloadTx), await signer.signTransaction(arbTx)];

	const maxGasCost = (GAS_LIMIT_PAYLOAD + GAS_LIMIT_ARB) * maxFeePerGas;

	console.log('─── USDU FX Arbitrage Bundle ─────────────────────────────────');
	console.log('Wallet:         ', signer.address, `(${ethers.formatEther(balance)} ETH)`);
	console.log('tx 1 (nonce ' + nonce + '):  DCIP-16 payload  ->', DELAYED_ACTION, `execute(${PROPOSAL_ID})`);
	console.log('tx 2 (nonce ' + (nonce + 1) + '):  FxArbitrageEuruV1 ->', FX_ARB);
	console.log('Flash loan:     ', ethers.formatUnits(AMOUNT, 6), 'EURC (Morpho, fee-free)');
	console.log('Min profit:     ', ethers.formatUnits(MIN_PROFIT, 6), 'EURC');
	console.log('Uniswap path:   ', UNI_PATH);
	console.log('Priority fee:   ', ethers.formatUnits(PRIORITY_FEE, 'gwei'), 'gwei');
	console.log('Max fee:        ', ethers.formatUnits(maxFeePerGas, 'gwei'), 'gwei');
	console.log('Max gas cost:   ', ethers.formatEther(maxGasCost), 'ETH (worst case, both txs at gas limit)');
	console.log('─────────────────────────────────────────────────────────────');
	console.log('Current Block:   ', latestBlock.number);
	console.log('Target Blocks:');
	BLOCK_OFFSETS.forEach((o) => console.log(`    [+${o}]  ${targetBlock + o}  (${bundleUuid(o)})`));
	console.log('─────────────────────────────────────────────────────────────');

	if (balance < maxGasCost) console.warn(`WARN: balance is below the worst-case gas cost (${ethers.formatEther(maxGasCost)} ETH)`);

	const broadcast = process.argv.includes('true');
	if (!broadcast) {
		console.log('\n(read-only) Pass "true" to broadcast.');
		return;
	}

	console.log('\nBroadcasting to builders...');
	await Promise.all(
		BLOCK_OFFSETS.flatMap((offset) => BUILDERS.map((b) => submitToBuilder(b, signedTxs, targetBlock + offset, offset, signer)))
	);
	console.log(
		`\nWindow: blocks ${targetBlock} → ${targetBlock + BLOCK_OFFSETS[BLOCK_OFFSETS.length - 1]} (~${
			BLOCK_OFFSETS.length * BLOCK_TIME
		}s). Re-run to extend, cancel with: npx ts-node scripts/various/fx-arbitrage-bundle.ts cancel`
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
