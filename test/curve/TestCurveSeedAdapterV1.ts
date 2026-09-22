import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther } from 'viem';
import { mainnet } from 'viem/chains';

import { ADDRESS } from '../../exports/address.config';
import { CurveSeedAdapterV1, ITwocrypto, ITwocryptoFactory, Stablecoin } from '../../typechain';
import { evm_increaseTime, resetFork } from '../helper';

const addr = ADDRESS[mainnet.id];

const EXPIRED_AT = 999999999999n;

// Curve's TwoCrypto-NG factory — same address across mainnet/arbitrum/etc, see
// https://etherscan.io/address/0x98ee851a00abee0d95d08cf4ca2bdce32aeaaf7f
const TWOCRYPTO_FACTORY = '0x98ee851a00abee0d95d08cf4ca2bdce32aeaaf7f';
const IMPLEMENTATION_ID = 0n;
const FX_PRESET = {
	A: 4_000_000n,
	gamma: 10_000_000_000_000n,
	mid_fee: 4_000_000n,
	out_fee: 20_000_000n,
	fee_gamma: 230_000_000_000_000n,
	allowed_extra_profit: 2_000_000_000_000n,
	adjustment_step: 146_000_000_000_000n,
	ma_exp_time: 1_800n,
};

// hardhat.config.ts's default fork pin — restored in `after()` below so this file doesn't leave the
// shared Hardhat Network on a different block for whichever test file runs next.
const DEFAULT_FORK_BLOCK = 24_244_916;

// After both USDU/EURU and USDU/CHFU TwoCrypto pools were deployed (see
// exports/address.config.ts), still unseeded (totalSupply() == 0).
const SEED_FORK_BLOCK = 26_028_896;

describe('CurveSeedAdapterV1', function () {
	let curator: SignerWithAddress;
	let other: SignerWithAddress;

	let usdu: Stablecoin;
	let euru: Stablecoin;
	let chfu: Stablecoin;

	let euruPool: ITwocrypto;
	let chfuPool: ITwocrypto;

	let adapter: CurveSeedAdapterV1;

	before(async function () {
		await resetFork(SEED_FORK_BLOCK);

		[, other] = await ethers.getSigners();

		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		await network.provider.request({ method: 'hardhat_setBalance', params: [addr.curator, '0x56BC75E2D63100000'] }); // 100 ETH
		curator = await ethers.getSigner(addr.curator);

		usdu = await ethers.getContractAt('Stablecoin', addr.usduStable);
		euru = await ethers.getContractAt('Stablecoin', addr.euruStable);
		chfu = await ethers.getContractAt('Stablecoin', addr.chfuStable);

		euruPool = await ethers.getContractAt('ITwocrypto', addr.curveTwocryptoNG_USDUEURU);
		chfuPool = await ethers.getContractAt('ITwocrypto', addr.curveTwocryptoNG_USDUCHFU);

		const AdapterFactory = await ethers.getContractFactory('CurveSeedAdapterV1');
		adapter = await AdapterFactory.deploy(addr.usduStable);

		// single adapter instance, registered as a module on all three stablecoins — real tokens with
		// existing supply, so setModule goes through the pending + timelock path
		await usdu.connect(curator).setModule(adapter, EXPIRED_AT, 'seed adapter');
		await euru.connect(curator).setModule(adapter, EXPIRED_AT, 'seed adapter');
		await chfu.connect(curator).setModule(adapter, EXPIRED_AT, 'seed adapter');

		await evm_increaseTime(7 * 24 * 3600 + 100);

		await usdu.acceptModule(adapter);
		await euru.acceptModule(adapter);
		await chfu.acceptModule(adapter);
	});

	after(async function () {
		await resetFork(DEFAULT_FORK_BLOCK);
	});

	it('rejects a zero amount', async function () {
		await expect(adapter.connect(curator).seed(addr.curveTwocryptoNG_USDUEURU, 0n, 0n, 0n)).to.be.revertedWithCustomError(
			adapter,
			'ZeroAmount'
		);
	});

	it('rejects a non-curator caller', async function () {
		await expect(
			adapter.connect(other).seed(addr.curveTwocryptoNG_USDUEURU, parseEther('100'), 0n, 0n)
		).to.be.revertedWithCustomError(usdu, 'NotCuratorRole');
	});

	it('rejects a real pool whose coin(0) is not USDU', async function () {
		const factory: ITwocryptoFactory = await ethers.getContractAt('ITwocryptoFactory', TWOCRYPTO_FACTORY);
		const poolCountBefore = await factory.pool_count();

		// EURU as coin(0), USDU as coin(1) — reversed order, should be rejected by _verifyPool
		await factory
			.connect(curator)
			.deploy_pool(
				'EURU/USDU reversed',
				'reversed',
				[addr.euruStable, addr.usduStable],
				IMPLEMENTATION_ID,
				FX_PRESET.A,
				FX_PRESET.gamma,
				FX_PRESET.mid_fee,
				FX_PRESET.out_fee,
				FX_PRESET.fee_gamma,
				FX_PRESET.allowed_extra_profit,
				FX_PRESET.adjustment_step,
				FX_PRESET.ma_exp_time,
				parseEther('1')
			);
		const reversedPool = await factory.pool_list(poolCountBefore);

		await expect(adapter.connect(curator).seed(reversedPool, parseEther('100'), 0n, 0n))
			.to.be.revertedWithCustomError(adapter, 'InvalidPool')
			.withArgs(reversedPool);
	});

	describe('USDU/EURU pool', function () {
		it('mints a price_scale-balanced pair, deposits, and burns the unused surplus', async function () {
			const amountUsdu = parseEther('100000');
			const priceScale = await euruPool.price_scale(); // price of coin(1) EURU, denominated in coin(0) USDU
			const expectedOther = (amountUsdu * parseEther('1')) / priceScale;

			const tx = await adapter.connect(curator).seed(euruPool, amountUsdu, 500n, 0n); // 5% surplus buffer
			const receipt = await tx.wait();

			const seedEvent = receipt!.logs
				.map((log) => {
					try {
						return adapter.interface.parseLog(log);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'Seed')!;

			expect(seedEvent.args.amountUsdu).to.equal(amountUsdu);
			expect(seedEvent.args.amountOther).to.equal(expectedOther);
			expect(seedEvent.args.shares).to.be.gt(0n);

			// balanced deposit landed exactly, at the pre-trade price_scale
			expect(await euruPool.balances(0)).to.equal(amountUsdu);
			expect(await euruPool.balances(1)).to.equal(expectedOther);

			// the 5% surplus buffer was minted then fully burned back — no leftover EURU
			expect(await usdu.balanceOf(adapter)).to.equal(0n);
			expect(await euru.balanceOf(adapter)).to.equal(0n);

			// LP tokens are held by the adapter, matching the emitted shares
			expect(await euruPool.balanceOf(adapter)).to.equal(seedEvent.args.shares);

			// debt tracked per pool
			const debt = await adapter.debts(euruPool);
			expect(debt.usdu).to.equal(amountUsdu);
			expect(debt.other).to.equal(expectedOther);
		});

		it('lets the curator unwind part of the LP position into the adapter, then repays debt from it', async function () {
			const adapterLP = await euruPool.balanceOf(adapter);
			const shares = adapterLP / 4n;

			const debtBefore = await adapter.debts(euruPool);

			await adapter.connect(curator).removeLiquidity(euruPool, shares, [0n, 0n]);

			expect(await euruPool.balanceOf(adapter)).to.equal(adapterLP - shares);
			const usduHeld = await usdu.balanceOf(adapter);
			const euruHeld = await euru.balanceOf(adapter);
			expect(usduHeld).to.be.gt(0n);
			expect(euruHeld).to.be.gt(0n);

			const curatorUsduBefore = await usdu.balanceOf(curator);
			const curatorEuruBefore = await euru.balanceOf(curator);

			const tx = await adapter.repayDebt(euruPool);
			const receipt = await tx.wait();
			const repayEvent = receipt!.logs
				.map((log) => {
					try {
						return adapter.interface.parseLog(log);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'RepayDebt')!;

			// removed a proportional (1/4) slice of a balanced pool, well under outstanding debt, so the
			// whole withdrawn balance is consumed by debt repayment — nothing left over for the curator
			expect(repayEvent.args.repaidUsdu).to.equal(usduHeld);
			expect(repayEvent.args.repaidOther).to.equal(euruHeld);
			expect(await usdu.balanceOf(adapter)).to.equal(0n);
			expect(await euru.balanceOf(adapter)).to.equal(0n);
			expect(await usdu.balanceOf(curator)).to.equal(curatorUsduBefore);
			expect(await euru.balanceOf(curator)).to.equal(curatorEuruBefore);

			const debtAfter = await adapter.debts(euruPool);
			expect(debtAfter.usdu).to.equal(debtBefore.usdu - usduHeld);
			expect(debtAfter.other).to.equal(debtBefore.other - euruHeld);
		});

		it('rejects removeLiquidity from a non-curator caller', async function () {
			await expect(adapter.connect(other).removeLiquidity(euruPool, 1n, [0n, 0n])).to.be.revertedWithCustomError(
				usdu,
				'NotCuratorRole'
			);
		});

		it('forwards surplus beyond debt to the curator on a full unwind', async function () {
			const debtBefore = await adapter.debts(euruPool);
			const adapterLP = await euruPool.balanceOf(adapter);

			await adapter.connect(curator).removeLiquidity(euruPool, adapterLP, [0n, 0n]);

			const usduHeld = await usdu.balanceOf(adapter);
			const euruHeld = await euru.balanceOf(adapter);

			const curatorUsduBefore = await usdu.balanceOf(curator);
			const curatorEuruBefore = await euru.balanceOf(curator);

			await adapter.repayDebt(euruPool);

			const debtAfter = await adapter.debts(euruPool);
			expect(debtAfter.usdu).to.equal(0n);
			expect(debtAfter.other).to.equal(0n);

			// anything withdrawn beyond the remaining debt (e.g. LP fee growth) went to the curator
			const expectedSurplusUsdu = usduHeld > debtBefore.usdu ? usduHeld - debtBefore.usdu : 0n;
			const expectedSurplusEuru = euruHeld > debtBefore.other ? euruHeld - debtBefore.other : 0n;
			expect(await usdu.balanceOf(curator)).to.equal(curatorUsduBefore + expectedSurplusUsdu);
			expect(await euru.balanceOf(curator)).to.equal(curatorEuruBefore + expectedSurplusEuru);
		});
	});

	describe('USDU/CHFU pool', function () {
		it('mints a price_scale-balanced pair, deposits, and burns the unused surplus', async function () {
			const amountUsdu = parseEther('100000');
			const priceScale = await chfuPool.price_scale(); // price of coin(1) CHFU, denominated in coin(0) USDU
			const expectedOther = (amountUsdu * parseEther('1')) / priceScale;

			await adapter.connect(curator).seed(chfuPool, amountUsdu, 500n, 0n);

			expect(await chfuPool.totalSupply()).to.be.gt(0n);
			expect(await chfuPool.balances(0)).to.equal(amountUsdu);
			expect(await chfuPool.balances(1)).to.equal(expectedOther);

			expect(await usdu.balanceOf(adapter)).to.equal(0n);
			expect(await chfu.balanceOf(adapter)).to.equal(0n);

			const debt = await adapter.debts(chfuPool);
			expect(debt.usdu).to.equal(amountUsdu);
			expect(debt.other).to.equal(expectedOther);
		});
	});
});
