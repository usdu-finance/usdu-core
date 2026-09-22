import { expect } from 'chai';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther } from 'viem';
import { mainnet } from 'viem/chains';

import { ADDRESS } from '../../exports/address.config';
import { ITwocryptoFactory, ITwocrypto, IERC20 } from '../../typechain';
import { evm_increaseTime, resetFork, setERC20Balance } from '../helper';

const addr = ADDRESS[mainnet.id];

// Curve's TwoCrypto-NG factory — same address across mainnet/arbitrum/etc, see
// https://etherscan.io/address/0x98ee851a00abee0d95d08cf4ca2bdce32aeaaf7f
const TWOCRYPTO_FACTORY = '0x98ee851a00abee0d95d08cf4ca2bdce32aeaaf7f';
const IMPLEMENTATION_ID = 0n;

// ---------------------------------------------------------------------------------------
// This is the tuning sandbox described in docs/ideas-for-modules/StableFxCurvePools.md — tweak
// either preset below and re-run to see the effect on slippage / price_scale movement / LP fee
// accrual. None of these numbers are final: they need to be validated against CurveSim / Curve's
// own FXSwap-simulation approach before any real deployment. They exist here only to compare a
// "typical volatile-pair" shape against a tighter "FX-pair" shape on the exact same trade script.
//
// Originally built against a synthetic STBLU/USDU pair (see docs/ideas-for-modules/StableUnit.md,
// superseded). Repointed at the real, deployed USDU/EURU pair once direct pairing (USDU as hub)
// was chosen instead — the preset comparisons themselves are scale-invariant w.r.t. price_scale,
// so the bps numbers below are unchanged from the STBLU version.
// ---------------------------------------------------------------------------------------

type PoolParams = {
	A: bigint;
	gamma: bigint;
	mid_fee: bigint;
	out_fee: bigint;
	fee_gamma: bigint;
	allowed_extra_profit: bigint;
	adjustment_step: bigint;
	ma_exp_time: bigint;
};

// Commonly-cited defaults for a volatile, uncorrelated Curve crypto-factory pair (e.g. ETH/altcoin).
// Kept only as a baseline to contrast against — NOT what we'd use for USDU's FX pools.
const VOLATILE_PRESET: PoolParams = {
	A: 400_000n,
	gamma: 145_000_000_000_000n,
	mid_fee: 26_000_000n, // 0.26%
	out_fee: 45_000_000n, // 0.45%
	fee_gamma: 230_000_000_000_000n,
	allowed_extra_profit: 2_000_000_000_000n,
	adjustment_step: 146_000_000_000_000n,
	ma_exp_time: 600n, // 10 min
};

// A tighter starting point for USDU's low-volatility FX pairs (USDU-EURU, USDU-CHFU): higher A
// and lower gamma to concentrate liquidity near price_scale, lower fees to encourage the
// arbitrage volume the whole peg-correction model relies on, and a longer ma_exp_time so
// price_oracle is harder to move within a single block (relevant later for any oracle-free
// cross-pool signal built on top of it).
const FX_PRESET: PoolParams = {
	A: 4_000_000n,
	gamma: 10_000_000_000_000n,
	mid_fee: 4_000_000n, // 0.04%
	out_fee: 20_000_000n, // 0.20%
	fee_gamma: 230_000_000_000_000n,
	allowed_extra_profit: 2_000_000_000_000n,
	adjustment_step: 146_000_000_000_000n,
	ma_exp_time: 1_800n, // 30 min
};

// "Liquid Staking Derivatives" preset from Curve's own pool-creation UI (curve.finance/#/deploy/pool),
// converted from its display units (fees in %, gamma/fee_gamma/allowed_extra_profit/adjustment_step as
// 0-1 fractions) into the raw 1e10/1e18-scaled integers deploy_pool expects. Worth trying against
// USDU's FX pairs precisely because LSD pairs (e.g. stETH/ETH) share the same "low relative
// volatility, not truly pegged" shape as an FX pair — much higher A than a generic volatile-pair
// default, much smaller gamma.
const LSD_PRESET: PoolParams = {
	A: 40_000_000n,
	gamma: 2_000_000_000_000_000n, // 0.002 * 1e18
	mid_fee: 3_000_000n, // 0.03%
	out_fee: 45_000_000n, // 0.45%
	fee_gamma: 300_000_000_000_000_000n, // 0.3 * 1e18
	allowed_extra_profit: 10_000_000_000n, // 0.00000001 * 1e18
	adjustment_step: 5_500_000_000_000n, // 0.0000055 * 1e18
	ma_exp_time: 866n, // raw tau; UI's "Moving Average Time" (half-life) = 866 * ln(2) ≈ 600s
};

// "Low Vol" preset from Curve's own pool-creation UI. Same shape as LSD (very high A, small gamma) but
// roughly half the concentration (A halved, gamma halved) and a much smaller fee_gamma (0.005 vs LSD's
// 0.3 — 60x smaller), meaning the fee ramps from mid_fee to out_fee far sooner as a trade imbalances the
// pool. So relative to LSD this trades a bit of price-impact headroom for a much less generous fee curve.
const LOW_VOL_PRESET: PoolParams = {
	A: 20_000_000n,
	gamma: 1_000_000_000_000_000n, // 0.001 * 1e18
	mid_fee: 5_000_000n, // 0.05%
	out_fee: 45_000_000n, // 0.45%
	fee_gamma: 5_000_000_000_000_000n, // 0.005 * 1e18
	allowed_extra_profit: 10_000_000_000n, // 0.00000001 * 1e18
	adjustment_step: 5_500_000_000_000n, // 0.0000055 * 1e18
	ma_exp_time: 600n,
};

// hardhat.config.ts's default fork pin — restored in `after()` below so this file doesn't leave
// the shared Hardhat Network on a different block for whichever test file runs next.
const DEFAULT_FORK_BLOCK = 24_244_916;

const SEED_AMOUNT = parseEther('20000');
// A placeholder par price for the generic preset-comparison sandbox below (not the real EUR/USD
// rate used at actual deploy time). The preset comparisons are scale-invariant w.r.t. price_scale,
// so this doesn't affect any of the bps numbers measured further down.
const INITIAL_PRICE = parseEther('1');

describe('USDU <> EURU TwoCrypto-NG pool (direct-pairing sandbox)', function () {
	let curator: SignerWithAddress;
	let user: SignerWithAddress;

	let usdu: IERC20;
	let euru: IERC20;
	let factory: ITwocryptoFactory;

	before(async function () {
		// hardhat.config.ts pins the fork at block 24,244,916, which predates EURU's deployment
		// (deployed between blocks 25,850,000-25,900,000) — re-fork later, for this file only.
		await resetFork(25_950_000);

		[, curator, user] = await ethers.getSigners();

		usdu = await ethers.getContractAt('IERC20', addr.usduStable);
		euru = await ethers.getContractAt('IERC20', addr.euruStable);
		factory = await ethers.getContractAt('ITwocryptoFactory', TWOCRYPTO_FACTORY);

		// sanity: the factory must have a pool implementation registered at IMPLEMENTATION_ID,
		// otherwise deploy_pool reverts with "pool implementation not set"
		expect(await factory.pool_implementations(IMPLEMENTATION_ID)).to.not.equal(ethers.ZeroAddress);

		// Both USDU and EURU are real, backed tokens — never minted for seeding (see
		// docs/ideas-for-modules/StableFxCurvePools.md's "seeding is a collateralized mint, not a
		// treasury draw" design decision), so we fake a real holder via storage instead of minting
		// either one out of thin air.
		// headroom for every pool seeded across the whole file (currently 11 seeds, 20k USDU + 20k
		// EURU each = 220k needed) plus room to grow as more presets get added
		await setERC20Balance(addr.usduStable, curator.address, SEED_AMOUNT * 50n);
		await setERC20Balance(addr.euruStable, curator.address, SEED_AMOUNT * 50n);
	});

	after(async function () {
		await resetFork(DEFAULT_FORK_BLOCK);
	});

	async function deployPool(name: string, symbol: string, params: PoolParams): Promise<ITwocrypto> {
		const poolCountBefore = await factory.pool_count();

		await factory
			.connect(curator)
			.deploy_pool(
				name,
				symbol,
				[addr.usduStable, addr.euruStable],
				IMPLEMENTATION_ID,
				params.A,
				params.gamma,
				params.mid_fee,
				params.out_fee,
				params.fee_gamma,
				params.allowed_extra_profit,
				params.adjustment_step,
				params.ma_exp_time,
				INITIAL_PRICE
			);

		const poolAddress = await factory.pool_list(poolCountBefore);
		return ethers.getContractAt('ITwocrypto', poolAddress);
	}

	async function seed(pool: ITwocrypto, amount: bigint = SEED_AMOUNT) {
		const poolAddress = await pool.getAddress();
		await usdu.connect(curator).approve(poolAddress, amount);
		await euru.connect(curator).approve(poolAddress, amount);
		await pool.connect(curator)['add_liquidity(uint256[2],uint256)']([amount, amount], 0n);
	}

	// -----------------------------------------------------------------------------------
	describe('Deployment', function () {
		it('deploys via the factory with USDU as coin(0), EURU as coin(1)', async function () {
			const pool = await deployPool('USDU/EURU', 'usduEuru', FX_PRESET);

			expect((await pool.coins(0)).toLowerCase()).to.equal(addr.usduStable.toLowerCase());
			expect((await pool.coins(1)).toLowerCase()).to.equal(addr.euruStable.toLowerCase());
			expect(await pool.A()).to.equal(FX_PRESET.A);
			expect(await pool.gamma()).to.equal(FX_PRESET.gamma);
			expect(await pool.mid_fee()).to.equal(FX_PRESET.mid_fee);
			// ma_time() reports the half-life derived from ma_exp_time (the input "tau"), i.e.
			// ma_exp_time * ln(2) — see params.vy's `_ma_time()` (uses 694/1000 as an integer ln(2))
			expect(await pool.ma_time()).to.equal((FX_PRESET.ma_exp_time * 694n) / 1000n);
		});

		it('seeds with balanced raw reserves and virtual_price == 1', async function () {
			const pool = await deployPool('USDU/EURU seed', 'seed', FX_PRESET);
			await seed(pool);

			expect(await pool.balances(0)).to.equal(SEED_AMOUNT);
			expect(await pool.balances(1)).to.equal(SEED_AMOUNT);
			expect(await pool.price_scale()).to.equal(INITIAL_PRICE);
			expect(await pool.get_virtual_price()).to.equal(parseEther('1'));
		});
	});

	// -----------------------------------------------------------------------------------
	describe('Imbalance & fee accrual', function () {
		let pool: ITwocrypto;

		beforeEach(async function () {
			pool = await deployPool('USDU/EURU trade', 'trade', FX_PRESET);
			await seed(pool);
			await usdu.connect(curator).transfer(user.address, parseEther('5000'));
		});

		it('a one-directional sell shifts pool balances toward the sold coin', async function () {
			const before0 = await pool.balances(0);
			const before1 = await pool.balances(1);
			const poolAddress = await pool.getAddress();

			await usdu.connect(user).approve(poolAddress, parseEther('5000'));
			await pool.connect(user)['exchange(uint256,uint256,uint256,uint256)'](0n, 1n, parseEther('5000'), 0n);

			// user sold USDU (index 0) for EURU (index 1): pool now holds more USDU, less EURU —
			// exactly the "USDU-EURU pool got expensive for EURU" shift described when routing
			// EURU -> USDU -> CHFU
			expect(await pool.balances(0)).to.be.greaterThan(before0);
			expect(await pool.balances(1)).to.be.lessThan(before1);
		});

		it('repeated round-trip trades grow virtual_price — the LP position earns fees while the pool churns', async function () {
			const poolAddress = await pool.getAddress();
			const vpBefore = await pool.get_virtual_price();

			for (let i = 0; i < 50; i++) {
				const usduIn = await usdu.balanceOf(user.address);
				await usdu.connect(user).approve(poolAddress, usduIn);
				await pool.connect(user)['exchange(uint256,uint256,uint256,uint256)'](0n, 1n, usduIn, 0n);

				const euruOut = await euru.balanceOf(user.address);
				await euru.connect(user).approve(poolAddress, euruOut);
				await pool.connect(user)['exchange(uint256,uint256,uint256,uint256)'](1n, 0n, euruOut, 0n);
			}

			const vpAfter = await pool.get_virtual_price();

			// this is the "consumes trading fees" part: whoever holds the LP shares (the future
			// curator seed adapter, protocol-owned liquidity) has a position whose redeemable value
			// grows via virtual_price as the pool churns
			expect(vpAfter).to.be.greaterThan(vpBefore);
		});

		it('a sustained one-directional decline moves price_oracle away from the seed price', async function () {
			const poolAddress = await pool.getAddress();
			const oracleBefore = await pool.price_oracle();

			// simulate USDU persistently "declining" in EURU terms: repeated sells of USDU into
			// the pool, with real time passing so ma_exp_time actually averages the new price in
			for (let i = 0; i < 10; i++) {
				await usdu.connect(curator).transfer(user.address, parseEther('1000'));
				await usdu.connect(user).approve(poolAddress, parseEther('1000'));
				await pool.connect(user)['exchange(uint256,uint256,uint256,uint256)'](0n, 1n, parseEther('1000'), 0n);
				await evm_increaseTime(3600);
			}

			const oracleAfter = await pool.price_oracle();
			expect(oracleAfter).to.not.equal(oracleBefore);
		});
	});

	// -----------------------------------------------------------------------------------
	describe('Parameter comparison: FX preset vs volatile-pair preset', function () {
		// This test found something worth flagging rather than hiding: FX_PRESET's much smaller
		// `gamma` gives it a narrower "flat" low-slippage zone around price_scale than
		// VOLATILE_PRESET. That wins at 1% of pool depth (34bps vs 43bps) but LOSES at every
		// larger size tried here — by 25% of pool depth FX_PRESET is worse (1984bps vs 1952bps).
		// So "tighter A + smaller gamma ⇒ always less slippage" is not actually true; gamma sets
		// the *width* of the tight zone, and FX_PRESET's A wasn't pushed up enough to compensate
		// for how much its gamma narrowed that zone. Real tuning needs to pick a target trade size
		// (how large a cross-FX arb trade should stay cheap) and solve for A/gamma around that,
		// rather than just dialing gamma down on intuition — exactly what CurveSim is for.
		it('logs slippage for all three presets across several trade sizes (1% - 25% of pool)', async function () {
			const presets: Record<string, PoolParams> = {
				fx: FX_PRESET,
				volatile: VOLATILE_PRESET,
				lsd: LSD_PRESET,
				lowVol: LOW_VOL_PRESET,
			};
			const pools: Record<string, ITwocrypto> = {};

			for (const [key, params] of Object.entries(presets)) {
				pools[key] = await deployPool(`USDU/EURU ${key}`, key, params);
				await seed(pools[key]);
			}

			for (const pct of [1n, 2n, 5n, 10n, 25n]) {
				const tradeAmount = (SEED_AMOUNT * pct) / 100n;
				const row: Record<string, string> = { pctOfPool: pct.toString() + '%' };

				for (const [key, pool] of Object.entries(pools)) {
					const dy = await pool.get_dy(0n, 1n, tradeAmount);
					row[key + 'SlippageBps'] = (((tradeAmount - dy) * 10_000n) / tradeAmount).toString();

					// every preset must still be within Curve's sane bounds: you get less out than
					// you put in (nonzero fee/slippage), but never zero or negative
					expect(dy).to.be.greaterThan(0n).and.to.be.lessThan(tradeAmount);
				}

				console.log(row);
			}
		});
	});

	// -----------------------------------------------------------------------------------
	// The two comparisons above bundle curve-shape price impact (A/gamma — closer to a free lunch,
	// a flatter curve doesn't cost LPs anything) together with the explicit fee rate (mid_fee/out_fee
	// — a real skim that funds the LP position but also raises the bar for the arbitrage-driven peg
	// correction from the design doc: if the fee eats the whole mispricing spread, no one bothers
	// correcting it). This isolates JUST the fee rate, holding LSD's curve shape fixed, to see that
	// tradeoff directly instead of asserting it.
	describe('Fee-rate tradeoff: LP revenue vs arbitrage dead-zone (LSD curve shape held fixed)', function () {
		const LSD_LOW_FEE: PoolParams = { ...LSD_PRESET, mid_fee: 1_000_000n, out_fee: 10_000_000n }; // 0.01% / 0.10%
		const LSD_HIGH_FEE: PoolParams = { ...LSD_PRESET, mid_fee: 10_000_000n, out_fee: 80_000_000n }; // 0.10% / 0.80%

		it('higher fees mean more LP revenue per trade but a wider round-trip dead-zone for arbitrageurs', async function () {
			const feeLevels: Record<string, PoolParams> = { lowFee: LSD_LOW_FEE, lsd: LSD_PRESET, highFee: LSD_HIGH_FEE };
			const pools: Record<string, ITwocrypto> = {};

			for (const [key, params] of Object.entries(feeLevels)) {
				pools[key] = await deployPool(`USDU/EURU ${key}`, key, params);
				await seed(pools[key]);
			}

			// a modest, plausible single-leg trade size — representative of one leg of a real
			// cross-pool arbitrage, not a stress-test size
			const tradeAmount = (SEED_AMOUNT * 1n) / 100n; // 1% of pool

			for (const [key, pool] of Object.entries(pools)) {
				const dyOut = await pool.get_dy(0n, 1n, tradeAmount); // USDU -> EURU
				const dyBack = await pool.get_dy(1n, 0n, dyOut); // EURU -> USDU (round trip, same pool)

				const lpRevenueBps = ((tradeAmount - dyOut) * 10_000n) / tradeAmount;
				const roundTripCostBps = ((tradeAmount - dyBack) * 10_000n) / tradeAmount;

				console.log({
					preset: key,
					mid_fee: feeLevels[key].mid_fee.toString(),
					out_fee: feeLevels[key].out_fee.toString(),
					lpRevenueBpsPerLeg: lpRevenueBps.toString(),
					// this single-pool round trip is a lower bound: a real cross-FX arb (e.g.
					// EURU -> USDU -> CHFU) pays this cost TWICE (once per pool, on two different
					// pools), so double this number for a realistic estimate of the actual
					// dead-zone a cross-FX arbitrageur faces
					roundTripCostBpsSinglePool: roundTripCostBps.toString(),
				});

				expect(dyOut).to.be.greaterThan(0n).and.to.be.lessThan(tradeAmount);
				expect(dyBack).to.be.greaterThan(0n).and.to.be.lessThan(dyOut);
			}
		});
	});

	// -----------------------------------------------------------------------------------
	// A real cross-FX arb (e.g. EURU -> USDU -> CHFU) does one leg each on TWO DIFFERENT pool
	// instances, not a round trip on one pool. The "double the single-pool round trip" estimate used
	// above is a reasonable proxy, but this measures it directly: two independent pool instances, one
	// leg through each. Both legs are USDU<>EURU here (no USDU<>CHFU pool exists yet to test against),
	// which is fine — the point is to measure the pure cost of routing through two pool *instances*
	// with the same parameters, not to model a real FX rate.
	describe('Two-pool triangular arb cost (real cost, not the single-pool proxy)', function () {
		const LSD_LOW_FEE: PoolParams = { ...LSD_PRESET, mid_fee: 1_000_000n, out_fee: 10_000_000n }; // 0.01% / 0.10%
		const LSD_HIGH_FEE: PoolParams = { ...LSD_PRESET, mid_fee: 10_000_000n, out_fee: 80_000_000n }; // 0.10% / 0.80%

		it('measures the actual two-pool cost against the single-pool proxy used earlier', async function () {
			const feeLevels: Record<string, PoolParams> = { lowFee: LSD_LOW_FEE, lsd: LSD_PRESET, highFee: LSD_HIGH_FEE };
			const tradeAmount = (SEED_AMOUNT * 1n) / 100n; // 1% of pool, same size as the single-pool test

			for (const [key, params] of Object.entries(feeLevels)) {
				const poolA = await deployPool(`USDU/EURU ${key} A`, key + 'A', params);
				const poolB = await deployPool(`USDU/EURU ${key} B`, key + 'B', params);
				await seed(poolA);
				await seed(poolB);

				// leg 1: USDU -> EURU on pool A (stand-in for USDU-EURU)
				const euruOut = await poolA.get_dy(0n, 1n, tradeAmount);
				// leg 2: EURU -> USDU on pool B (stand-in for the USDU-CHFU leg of a real triangle, using
				// USDU/EURU again since only the routing cost matters here, not a real FX rate)
				const usduBack = await poolB.get_dy(1n, 0n, euruOut);

				const twoPoolCostBps = ((tradeAmount - usduBack) * 10_000n) / tradeAmount;

				// same trade, single pool, for direct comparison against the "double it" proxy
				const dyOutSame = await poolA.get_dy(0n, 1n, tradeAmount);
				const dyBackSame = await poolA.get_dy(1n, 0n, dyOutSame);
				const singlePoolRoundTripBps = ((tradeAmount - dyBackSame) * 10_000n) / tradeAmount;

				console.log({
					preset: key,
					twoPoolCostBps: twoPoolCostBps.toString(),
					singlePoolRoundTripBps: singlePoolRoundTripBps.toString(),
				});

				expect(euruOut).to.be.greaterThan(0n).and.to.be.lessThan(tradeAmount);
				expect(usduBack).to.be.greaterThan(0n).and.to.be.lessThan(euruOut);
			}
		});
	});
});
