import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import * as helper from '@nomicfoundation/hardhat-network-helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther, parseUnits, formatEther, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';

import { ADDRESS } from '../../exports/address.config';
import { ITwocrypto, IERC20, ISwapBridgeV1, ICurveStableSwapNG } from '../../typechain';
import { evm_increaseTime, resetFork, setERC20Balance } from '../helper';

// DCIP-16's on-chain actions, as exported from the DAO proposal
import proposal from './fixtures/proposal-DCIP-16-actions.json';

const addr = ADDRESS[mainnet.id];

// hardhat.config.ts's default fork pin — restored in `after()` below so this file doesn't leave the
// shared Hardhat Network on a different block for whichever test file runs next.
const DEFAULT_FORK_BLOCK = 24_244_916;

// Both FX pools deployed and still unseeded, and the CurveSeedAdapterV1 module still pending on USDU,
// EURU and CHFU (acceptModule's timelock expires ~21h after this block) — i.e. the on-chain state right
// before DCIP-16's actions become executable.
const FORK_BLOCK = 26_126_094;

// External tokens / venues the arbitrage routes through (none of them are part of this protocol).
const ZCHF = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const EURC = '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c';
const UNISWAP_ROUTER02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
// Locked call data for FxArbitrageEuruV1: Uniswap path USDC -(0.05%)-> EURC, and execute(10_000 EURC, path, 0).
const UNI_PATH_USDC_EURC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb480001f41abaea1f7c830bd89acc67ec4af516284b1bc33c';
const EXECUTE_CALLDATA_10K =
	'0xca72605800000000000000000000000000000000000000000000000000000002540be40000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002ba0b86991c6218b36c1d19d4a2e9eb0ce3606eb480001f41abaea1f7c830bd89acc67ec4af516284b1bc33c000000000000000000000000000000000000000000';
const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';

const UNISWAP_ABI = [
	'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256)',
	'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)',
];

// New FX rates the pools haven't repriced to yet: 1,204.82 USD == 1,000 CHF, 1,120.57 USD == 1,000 EUR.
const FX_USD_PER_CHF = parseEther('1.20482');
const FX_USD_PER_EUR = parseEther('1.12057');

// The timelock on the stablecoins' acceptModule is 7 days (already running); DCIP-16 becomes executable
// 24h from the fork block, per the proposal timeline.
const WAIT_BEFORE_PAYLOAD = 24 * 3600;

// Candidate trade sizes, in the route's start asset (ZCHF resp. USDC, both ~1.2 USD per CHF/EUR unit).
const SIZES = [1_000, 2_500, 5_000, 7_500, 10_000, 15_000, 20_000, 30_000, 50_000];

describe('FX arbitrage: stale USDU/EURU + USDU/CHFU pools after DCIP-16 seeding', function () {
	let curator: SignerWithAddress;
	let arb: SignerWithAddress;

	let usdu: IERC20;
	let euru: IERC20;
	let chfu: IERC20;
	let zchf: IERC20;
	let usdc: IERC20;
	let eurc: IERC20;

	let euruPool: ITwocrypto;
	let chfuPool: ITwocrypto;
	let usdcUsduPool: ICurveStableSwapNG; // coin(0) USDC, coin(1) USDU
	let chfuBridge: ISwapBridgeV1; // ZCHF <-> CHFU
	let euruBridge: ISwapBridgeV1; // EURC <-> EURU
	let router: any;

	before(async function () {
		await resetFork(FORK_BLOCK);
		[, , arb] = await ethers.getSigners();

		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		await network.provider.request({ method: 'hardhat_setBalance', params: [addr.curator, '0x56BC75E2D63100000'] }); // 100 ETH
		curator = await ethers.getSigner(addr.curator);

		usdu = await ethers.getContractAt('IERC20', addr.usduStable);
		euru = await ethers.getContractAt('IERC20', addr.euruStable);
		chfu = await ethers.getContractAt('IERC20', addr.chfuStable);
		zchf = await ethers.getContractAt('IERC20', ZCHF);
		usdc = await ethers.getContractAt('IERC20', USDC);
		eurc = await ethers.getContractAt('IERC20', EURC);

		euruPool = await ethers.getContractAt('ITwocrypto', addr.curveTwocryptoNG_USDUEURU);
		chfuPool = await ethers.getContractAt('ITwocrypto', addr.curveTwocryptoNG_USDUCHFU);
		usdcUsduPool = await ethers.getContractAt('ICurveStableSwapNG', addr.curveStableSwapNG_USDCUSDU);
		chfuBridge = await ethers.getContractAt('ISwapBridgeV1', addr.chfuSwapBridgeMorphoV1_ZCHF_module);
		euruBridge = await ethers.getContractAt('ISwapBridgeV1', addr.euruSwapBridgeMorphoV1_steakEURC_module);
		router = new ethers.Contract(UNISWAP_ROUTER02, UNISWAP_ABI, arb);

		// --- DCIP-16: acceptModule(adapter) on USDU/EURU/CHFU, then seed both pools at 100k USDU depth ---
		// (executed as the DAO, i.e. addr.curator, which is the adapter's curator)
		await evm_increaseTime(WAIT_BEFORE_PAYLOAD);

		expect(await euruPool.totalSupply()).to.equal(0n);
		expect(await chfuPool.totalSupply()).to.equal(0n);

		for (const action of proposal) {
			const tx = await curator.sendTransaction({ to: action.to, value: BigInt(action.value), data: action.data });
			await tx.wait();
		}

		// the pools are now live, balanced at their *stale* price_scale
		expect(await euruPool.totalSupply()).to.be.greaterThan(0n);
		expect(await chfuPool.totalSupply()).to.be.greaterThan(0n);
	});

	after(async function () {
		await resetFork(DEFAULT_FORK_BLOCK);
	});

	// every test starts from the same post-DCIP-16 state — executed arbitrages move pool and bridge
	// state (e.g. a swapIn raises the bridge's totalMinted, which is what later lets swapOut redeem)
	let snapshot: Awaited<ReturnType<typeof helper.takeSnapshot>>;
	beforeEach(async function () {
		snapshot = await helper.takeSnapshot();
	});
	afterEach(async function () {
		await snapshot.restore();
	});

	// -----------------------------------------------------------------------------------
	// helpers

	// "Flashloan" simulation: the arbitrageur starts each route with exactly `amount` of `token`
	// (faked via storage instead of a real whale/flashloan provider) and we measure what's left at the end.
	async function fund(token: string, amount: bigint) {
		await setERC20Balance(token, arb.address, amount);
	}

	async function approve(token: IERC20, spender: string, amount: bigint) {
		await token.connect(arb).approve(spender, amount);
	}

	const bal = (token: IERC20) => token.balanceOf(arb.address);

	// ZCHF -> CHFU -> USDU -> USDC -> (USDT) -> ZCHF
	async function routeSellChfu(zchfIn: bigint): Promise<bigint> {
		await fund(ZCHF, zchfIn);

		await approve(zchf, await chfuBridge.getAddress(), zchfIn);
		await chfuBridge.connect(arb).swapIn(zchfIn); // bridge-swap module: ZCHF -> CHFU

		const chfuBal = await bal(chfu);
		await approve(chfu, await chfuPool.getAddress(), chfuBal);
		await chfuPool.connect(arb)['exchange(uint256,uint256,uint256,uint256)'](1, 0, chfuBal, 0); // CHFU -> USDU

		const usduBal = await bal(usdu);
		await approve(usdu, await usdcUsduPool.getAddress(), usduBal);
		await usdcUsduPool.connect(arb)['exchange(int128,int128,uint256,uint256)'](1, 0, usduBal, 0); // USDU -> USDC

		const usdcBal = await bal(usdc);
		await approve(usdc, UNISWAP_ROUTER02, usdcBal);
		// ZCHF has no USDC liquidity on Uniswap v3, only a 0.01% ZCHF/USDT pool, so hop through USDT
		const path = ethers.solidityPacked(['address', 'uint24', 'address', 'uint24', 'address'], [USDC, 100, USDT, 100, ZCHF]);
		await router.exactInput({ path, recipient: arb.address, amountIn: usdcBal, amountOutMinimum: 0 }); // USDC -> ZCHF

		return bal(zchf);
	}

	// USDC -> USDU -> EURU -> EURC -> USDC. EURU is priced *cheap* in its pool (see the test below), so
	// the profitable direction buys EURU in the pool and redeems it through the bridge.
	async function routeBuyEuru(usdcIn: bigint): Promise<bigint> {
		await fund(USDC, usdcIn);

		await approve(usdc, await usdcUsduPool.getAddress(), usdcIn);
		await usdcUsduPool.connect(arb)['exchange(int128,int128,uint256,uint256)'](0, 1, usdcIn, 0); // USDC -> USDU

		const usduBal = await bal(usdu);
		await approve(usdu, await euruPool.getAddress(), usduBal);
		await euruPool.connect(arb)['exchange(uint256,uint256,uint256,uint256)'](0, 1, usduBal, 0); // USDU -> EURU

		await euruBridge.connect(arb).swapOut(await bal(euru)); // bridge-swap module: EURU -> EURC (burns EURU)

		const eurcBal = await bal(eurc);
		await approve(eurc, UNISWAP_ROUTER02, eurcBal);
		await router.exactInputSingle({
			tokenIn: EURC,
			tokenOut: USDC,
			fee: 500,
			recipient: arb.address,
			amountIn: eurcBal,
			amountOutMinimum: 0,
			sqrtPriceLimitX96: 0,
		}); // EURC -> USDC

		return bal(usdc);
	}

	// The mirror image of routeSellChfu, for EURU: USDC -> EURC -> EURU -> USDU -> USDC.
	async function routeSellEuru(usdcIn: bigint): Promise<bigint> {
		await fund(USDC, usdcIn);

		await approve(usdc, UNISWAP_ROUTER02, usdcIn);
		await router.exactInputSingle({
			tokenIn: USDC,
			tokenOut: EURC,
			fee: 500,
			recipient: arb.address,
			amountIn: usdcIn,
			amountOutMinimum: 0,
			sqrtPriceLimitX96: 0,
		}); // USDC -> EURC

		const eurcBal = await bal(eurc);
		await approve(eurc, await euruBridge.getAddress(), eurcBal);
		await euruBridge.connect(arb).swapIn(eurcBal); // bridge-swap module: EURC -> EURU

		const euruBal = await bal(euru);
		await approve(euru, await euruPool.getAddress(), euruBal);
		await euruPool.connect(arb)['exchange(uint256,uint256,uint256,uint256)'](1, 0, euruBal, 0); // EURU -> USDU

		const usduBal = await bal(usdu);
		await approve(usdu, await usdcUsduPool.getAddress(), usduBal);
		await usdcUsduPool.connect(arb)['exchange(int128,int128,uint256,uint256)'](1, 0, usduBal, 0); // USDU -> USDC

		return bal(usdc);
	}

	type Sweep = { size: number; out: bigint; profit: bigint };

	// Runs `route` at every candidate size against an identical pre-trade state (snapshot/revert between
	// runs), returns the table plus the best row.
	async function sweep(route: (amountIn: bigint) => Promise<bigint>, decimals: number): Promise<{ rows: Sweep[]; best: Sweep }> {
		const rows: Sweep[] = [];
		for (const size of SIZES) {
			const snapshot = await helper.takeSnapshot();
			const amountIn = parseUnits(size.toString(), decimals);
			const out = await route(amountIn);
			rows.push({ size, out, profit: out - amountIn });
			await snapshot.restore();
		}
		const best = rows.reduce((a, b) => (b.profit > a.profit ? b : a));
		return { rows, best };
	}

	function printSweep(title: string, rows: Sweep[], decimals: number) {
		console.log(title);
		console.table(
			rows.map((r) => ({
				size: r.size,
				out: formatUnits(r.out, decimals),
				profit: formatUnits(r.profit, decimals),
				'profit bps': Number((r.profit * 10_000n) / parseUnits(r.size.toString(), decimals)),
			}))
		);
	}

	// -----------------------------------------------------------------------------------

	it('DCIP-16 seeded both pools at the stale price_scale, which no longer matches the new FX rate', async function () {
		const chfScale = await chfuPool.price_scale();
		const eurScale = await euruPool.price_scale();
		console.log('CHFU price_scale', formatEther(chfScale), '| EURU price_scale', formatEther(eurScale), '| new FX CHF', formatEther(FX_USD_PER_CHF), 'EUR', formatEther(FX_USD_PER_EUR));

		// Each pool holds ~100k USDU + ~100k USD of the other leg => ~200k TVL
		for (const [pool, name] of [[chfuPool, 'CHFU'], [euruPool, 'EURU']] as const) {
			const usduBal = await pool.balances(0);
			const otherBal = await pool.balances(1);
			const tvlUsd = usduBal + (otherBal * (await pool.price_scale())) / parseEther('1');
			console.log(name, 'pool TVL (USD):', formatEther(tvlUsd));
			expect(tvlUsd).to.be.closeTo(parseEther('200000'), parseEther('2000'));
		}

		// CHF and EUR both dropped vs the pools' prices: CHFU and EURU are priced *rich* => sell them into the pools.
		expect(chfScale).to.be.greaterThan(FX_USD_PER_CHF);
		expect(eurScale).to.be.greaterThan(FX_USD_PER_EUR);
	});

	it('the bridge modules charge 10 bps in both directions, and the routes pay it', async function () {
		const ppm = async (b: any) => [await b.swapInFeePPM(), await b.swapOutFeePPM()];
		const chfuFees = await ppm(await ethers.getContractAt('SwapBridgeMorphoV1', addr.chfuSwapBridgeMorphoV1_ZCHF_module));
		const euruFees = await ppm(await ethers.getContractAt('SwapBridgeMorphoV1', addr.euruSwapBridgeMorphoV1_steakEURC_module));
		expect(chfuFees).to.deep.equal([1000n, 1000n]); // 1000 ppm == 10 bps
		expect(euruFees).to.deep.equal([1000n, 1000n]);

		// ZCHF -> CHFU: exactly 10 bps are withheld from what lands in the arbitrageur's wallet
		const zchfIn = parseEther('10000');
		await fund(ZCHF, zchfIn);
		await approve(zchf, await chfuBridge.getAddress(), zchfIn);
		await chfuBridge.connect(arb).swapIn(zchfIn);
		expect(await bal(chfu)).to.equal(parseEther('9990'));

		// EURC -> EURU: same, with EURC's 6 decimals scaled up to EURU's 18
		const eurcIn = parseUnits('10000', 6);
		await fund(EURC, eurcIn);
		await approve(eurc, await euruBridge.getAddress(), eurcIn);
		await euruBridge.connect(arb).swapIn(eurcIn);
		expect(await bal(euru)).to.equal(parseEther('9990'));
	});

	it('CHF route: ZCHF -> CHFU (bridge) -> USDU (pool) -> USDC (stable pool) -> ZCHF is profitable', async function () {
		const { rows, best } = await sweep(routeSellChfu, 18);
		printSweep('ZCHF -> CHFU -> USDU -> USDC -> ZCHF', rows, 18);

		expect(best.profit).to.be.greaterThan(0n);

		// execute the best size for real and pin the result
		const before = await bal(zchf);
		const out = await routeSellChfu(parseEther(best.size.toString()));
		console.log(`executed ${best.size} ZCHF -> ${formatEther(out)} ZCHF (profit ${formatEther(out - parseEther(best.size.toString()))})`);
		expect(out).to.equal(best.out);
		expect(before).to.equal(0n);

		// the arbitrage pulled CHFU's in-pool price back toward the new FX rate
		expect(await chfuPool.get_dy(1, 0, parseEther('1000'))).to.be.lessThan(
			(parseEther('1000') * (await chfuPool.price_scale())) / parseEther('1')
		);
	});

	it('EUR route: USDC -> EURC -> EURU (bridge) -> USDU (pool) -> USDC is profitable', async function () {
		const { rows, best } = await sweep(routeSellEuru, 6);
		printSweep('USDC -> EURC -> EURU -> USDU -> USDC', rows, 6);

		// The pool is shallow: sizes past ~10-15% of depth already lose money to slippage.
		expect(best.profit).to.be.greaterThan(0n);
		expect(rows[rows.length - 1].profit).to.be.lessThan(0n);

		const startSize = parseUnits(best.size.toString(), 6);
		const out = await routeSellEuru(startSize);
		console.log(`executed ${best.size} USDC -> ${formatUnits(out, 6)} USDC (profit ${formatUnits(out - startSize, 6)})`);
		expect(out).to.equal(best.out);
	});

	it('EUR route, reversed (buy EURU in the pool, redeem via bridge) is not an option: the bridge only redeems what it minted', async function () {
		// EURU in the pool was minted by CurveSeedAdapterV1, not by the EURC bridge, so the bridge's
		// totalMinted (~1.4 EURU) is all it can ever burn/redeem — swapOut underflows beyond that.
		await expect(routeBuyEuru(parseUnits('10000', 6))).to.be.rejectedWith(/panic code 0x11/);
	});

	it('Uniswap v3 fee tiers for the closing USDC -> EURC leg: which pool has the better liquidity', async function () {
		const factory = new ethers.Contract('0x1F98431c8aD98523631AE4a59f267346ea31F984', ['function getPool(address,address,uint24) view returns (address)'], ethers.provider);
		for (const fee of [100, 500, 3000, 10000]) {
			const pool = await factory.getPool(USDC, EURC, fee);
			if (pool === ethers.ZeroAddress) {
				console.log(`fee ${fee}: no pool`);
				continue;
			}
			const [usdcBal, eurcBal] = await Promise.all([usdc.balanceOf(pool), eurc.balanceOf(pool)]);
			console.log(`fee ${fee}: ${pool} holds ${formatUnits(usdcBal, 6)} USDC + ${formatUnits(eurcBal, 6)} EURC`);
		}
	});

	it('FxArbitrageEuruV1: Morpho flash loan of EURC, bridge -> pool -> pool -> Uniswap, profit to owner', async function () {
		const factory = await ethers.getContractFactory('FxArbitrageEuruV1');
		const bot = await factory.deploy(arb.address, MORPHO, UNISWAP_ROUTER02, await euruBridge.getAddress(), await euruPool.getAddress(), await usdcUsduPool.getAddress());
		const path = UNI_PATH_USDC_EURC;

		// the locked call data is what the addresses/fee encode to, and what execute() is called with
		expect(ethers.solidityPacked(['address', 'uint24', 'address'], [USDC, 500, EURC])).to.equal(UNI_PATH_USDC_EURC);
		expect(bot.interface.encodeFunctionData('execute', [parseUnits('10000', 6), path, 0n])).to.equal(EXECUTE_CALLDATA_10K);

		// non-owner and wrong path are rejected
		await expect(bot.connect(curator).execute(parseUnits('1000', 6), path, 0)).to.be.revertedWithCustomError(bot, 'OwnableUnauthorizedAccount');
		await expect(bot.connect(arb).execute(parseUnits('1000', 6), ethers.solidityPacked(['address', 'uint24', 'address'], [EURC, 500, USDC]), 0)).to.be.revertedWithCustomError(bot, 'BadPath');
		// the callback can't be driven by anyone but Morpho
		await expect(bot.connect(arb).onMorphoFlashLoan(1, '0x')).to.be.revertedWithCustomError(bot, 'NotMorpho');

		// size sweep (EURC)
		const rows: { size: number; profit: bigint }[] = [];
		for (const size of SIZES) {
			try {
				const profit = await bot.connect(arb).execute.staticCall(parseUnits(size.toString(), 6), path, 0);
				rows.push({ size, profit });
			} catch {
				rows.push({ size, profit: -1n });
			}
		}
		console.table(rows.map((r) => ({ size: r.size, profit: r.profit < 0n ? 'reverts (loss/liquidity)' : formatUnits(r.profit, 6) })));
		const best = rows.reduce((a, b) => (b.profit > a.profit ? b : a));
		expect(best.profit).to.be.greaterThan(0n);

		// minProfit is enforced, then execute for real
		await expect(bot.connect(arb).execute(parseUnits(best.size.toString(), 6), path, best.profit + 1n)).to.be.revertedWithCustomError(bot, 'InsufficientProfit');
		const before = await bal(eurc);
		await bot.connect(arb).execute(parseUnits(best.size.toString(), 6), path, best.profit);
		expect((await bal(eurc)) - before).to.equal(best.profit);
		expect(await eurc.balanceOf(await bot.getAddress())).to.equal(0n);
	});
});
