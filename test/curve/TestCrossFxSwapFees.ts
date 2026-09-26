import { expect } from 'chai';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther, formatEther } from 'viem';
import { mainnet } from 'viem/chains';

import { ADDRESS } from '../../exports/address.config';
import { ITwocrypto, IERC20 } from '../../typechain';
import { resetFork, setERC20Balance } from '../helper';

const addr = ADDRESS[mainnet.id];

// hardhat.config.ts's default fork pin — restored in `after()` below so this file doesn't leave the
// shared Hardhat Network on a different block for whichever test file runs next.
const DEFAULT_FORK_BLOCK = 24_244_916;

// After both USDU/EURU and USDU/CHFU TwoCrypto pools were deployed (see exports/address.config.ts),
// still unseeded (totalSupply() == 0) — same block used in TestCurveSeedAdapterV1.ts.
const SEED_FORK_BLOCK = 26_028_896;

// Depth to seed each real pool with, balanced at its own live price_scale (mirrors what
// CurveSeedAdapterV1.seed() does, minus the mint/debt bookkeeping — this file only cares about the
// resulting swap cost, not who supplied the liquidity).
const SEED_USDU = parseEther('100000');

// Trade sizes to probe, denominated in whichever currency a given path starts in. Spans small
// (1% of pool depth) to a deliberate stress size (50% of pool depth) to show how fee/slippage
// grows with size, not just its floor.
const TRADE_SIZES = [parseEther('1000'), parseEther('10000'), parseEther('25000'), parseEther('50000')];

describe('Cross-FX swap fees across USDU/EURU/CHFU', function () {
	let seeder: SignerWithAddress;

	let usdu: IERC20;
	let euru: IERC20;
	let chfu: IERC20;

	let euruPool: ITwocrypto;
	let chfuPool: ITwocrypto;

	before(async function () {
		await resetFork(SEED_FORK_BLOCK);
		[, seeder] = await ethers.getSigners();

		// SEED_FORK_BLOCK's real historical baseFeePerGas spikes well above ethers' default fee
		// estimate — see TestCurveSeedAdapterV1.ts for the same fix. Only needed for the seeding
		// transactions below; get_dy calls further down are view calls and don't pay gas at all.
		const forkedBaseFee = (await ethers.provider.getBlock('latest'))!.baseFeePerGas!;
		const feeOverrides = { maxFeePerGas: forkedBaseFee * 4n, maxPriorityFeePerGas: forkedBaseFee };

		usdu = await ethers.getContractAt('IERC20', addr.usduStable);
		euru = await ethers.getContractAt('IERC20', addr.euruStable);
		chfu = await ethers.getContractAt('IERC20', addr.chfuStable);

		euruPool = await ethers.getContractAt('ITwocrypto', addr.curveTwocryptoNG_USDUEURU);
		chfuPool = await ethers.getContractAt('ITwocrypto', addr.curveTwocryptoNG_USDUCHFU);

		async function seedPool(pool: ITwocrypto, otherToken: IERC20, otherAddress: string) {
			// balanced at the pool's own live price_scale, same formula CurveSeedAdapterV1.seed() uses
			const priceScale: bigint = await pool.price_scale();
			const amountOther = (SEED_USDU * parseEther('1')) / priceScale;

			await setERC20Balance(addr.usduStable, seeder.address, SEED_USDU);
			await setERC20Balance(otherAddress, seeder.address, amountOther);

			const poolAddress = await pool.getAddress();
			await usdu.connect(seeder).approve(poolAddress, SEED_USDU, feeOverrides);
			await otherToken.connect(seeder).approve(poolAddress, amountOther, feeOverrides);
			await pool.connect(seeder)['add_liquidity(uint256[2],uint256)']([SEED_USDU, amountOther], 0n, feeOverrides);
		}

		await seedPool(euruPool, euru, addr.euruStable);
		await seedPool(chfuPool, chfu, addr.chfuStable);
	});

	after(async function () {
		await resetFork(DEFAULT_FORK_BLOCK);
	});

	// Fee-free benchmark: what `amountIn` of coin `i` would be worth in the other coin at the pool's
	// current price_scale, with zero fee and zero price impact. get_dy's real output is measured
	// against this to isolate exactly what the trade cost (fee + slippage combined).
	async function idealOut(pool: ITwocrypto, i: 0n | 1n, amountIn: bigint): Promise<bigint> {
		const priceScale: bigint = await pool.price_scale(); // price of coin(1) denominated in coin(0)==USDU
		return i === 0n ? (amountIn * parseEther('1')) / priceScale : (amountIn * priceScale) / parseEther('1');
	}

	function bps(ideal: bigint, actual: bigint): bigint {
		if (ideal === 0n) return 0n;
		return ((ideal - actual) * 10_000n) / ideal;
	}

	it('prints fee/slippage (bps) for every directional path and trade size', async function () {
		const rows: Record<string, string>[] = [];

		for (const size of TRADE_SIZES) {
			const row: Record<string, string> = { size: formatEther(size) };

			// single hop, both directions on each pool
			row['USDU>EURU'] = bps(await idealOut(euruPool, 0n, size), await euruPool.get_dy(0n, 1n, size)).toString();
			row['EURU>USDU'] = bps(await idealOut(euruPool, 1n, size), await euruPool.get_dy(1n, 0n, size)).toString();
			row['USDU>CHFU'] = bps(await idealOut(chfuPool, 0n, size), await chfuPool.get_dy(0n, 1n, size)).toString();
			row['CHFU>USDU'] = bps(await idealOut(chfuPool, 1n, size), await chfuPool.get_dy(1n, 0n, size)).toString();

			// two-hop cross paths, routed through USDU as the hub — the real output chains leg 1's
			// actual (fee-laden) proceeds into leg 2's get_dy, exactly as a real sequential swap would;
			// the ideal benchmark composes both legs' price_scale, i.e. the true implied cross rate.
			{
				const usduOut = await euruPool.get_dy(1n, 0n, size); // EURU -> USDU
				const chfuOut = await chfuPool.get_dy(0n, 1n, usduOut); // USDU -> CHFU
				const idealUsdu = await idealOut(euruPool, 1n, size);
				const idealChfu = await idealOut(chfuPool, 0n, idealUsdu);
				row['EURU>CHFU'] = bps(idealChfu, chfuOut).toString();
			}
			{
				const usduOut = await chfuPool.get_dy(1n, 0n, size); // CHFU -> USDU
				const euruOut = await euruPool.get_dy(0n, 1n, usduOut); // USDU -> EURU
				const idealUsdu = await idealOut(chfuPool, 1n, size);
				const idealEuru = await idealOut(euruPool, 0n, idealUsdu);
				row['CHFU>EURU'] = bps(idealEuru, euruOut).toString();
			}

			rows.push(row);

			for (const [key, value] of Object.entries(row)) {
				if (key === 'size') continue;
				// real trade: never a free lunch (0bps) and never pays back more than it put in
				expect(Number(value)).to.be.greaterThan(0).and.to.be.lessThan(10_000);
			}
		}

		console.table(rows);
	});
});
