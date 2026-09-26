import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther } from 'viem';
import { mainnet } from 'viem/chains';

import { ADDRESS } from '../../exports/address.config';
import { CurveSeedAdapterV1, ITwocrypto, ITwocryptoFactory, Stablecoin } from '../../typechain';
import { evm_increaseTime, resetFork, setERC20Balance } from '../helper';

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

		// SEED_FORK_BLOCK's real historical baseFeePerGas spikes well above ethers' default fee
		// estimate (derived from the preceding blocks' fee history), so the very first tx after a
		// reset can underbid the next block — pin generous EIP-1559 overrides off the forked block
		// itself rather than relying on auto-estimation here.
		const forkedBaseFee = (await ethers.provider.getBlock('latest'))!.baseFeePerGas!;
		const feeOverrides = { maxFeePerGas: forkedBaseFee * 4n, maxPriorityFeePerGas: forkedBaseFee };

		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		await network.provider.request({ method: 'hardhat_setBalance', params: [addr.curator, '0x56BC75E2D63100000'] }); // 100 ETH
		curator = await ethers.getSigner(addr.curator);

		usdu = await ethers.getContractAt('Stablecoin', addr.usduStable);
		euru = await ethers.getContractAt('Stablecoin', addr.euruStable);
		chfu = await ethers.getContractAt('Stablecoin', addr.chfuStable);

		euruPool = await ethers.getContractAt('ITwocrypto', addr.curveTwocryptoNG_USDUEURU);
		chfuPool = await ethers.getContractAt('ITwocrypto', addr.curveTwocryptoNG_USDUCHFU);

		const AdapterFactory = await ethers.getContractFactory('CurveSeedAdapterV1');
		adapter = await AdapterFactory.deploy(
			addr.usduStable,
			[addr.curveTwocryptoNG_USDUEURU, addr.curveTwocryptoNG_USDUCHFU],
			feeOverrides
		);

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

	it('rejects a pool not on the deploy-time allowlist', async function () {
		const factory: ITwocryptoFactory = await ethers.getContractAt('ITwocryptoFactory', TWOCRYPTO_FACTORY);
		const poolCountBefore = await factory.pool_count();

		// a real, correctly-ordered USDU/EURU-shaped pool, but never passed to the adapter's constructor
		await factory
			.connect(curator)
			.deploy_pool(
				'USDU/EURU unlisted',
				'unlisted',
				[addr.usduStable, addr.euruStable],
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
		const unlistedPool = await factory.pool_list(poolCountBefore);

		await expect(adapter.connect(curator).seed(unlistedPool, parseEther('100'), 0n, 0n))
			.to.be.revertedWithCustomError(adapter, 'PoolNotAllowed')
			.withArgs(unlistedPool);
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

		it('unwinds part of the LP position and settles debt from it atomically, in the same call', async function () {
			const adapterLP = await euruPool.balanceOf(adapter);
			const shares = adapterLP / 4n;

			const debtBefore = await adapter.debts(euruPool);

			const curatorUsduBefore = await usdu.balanceOf(curator);
			const curatorEuruBefore = await euru.balanceOf(curator);

			const tx = await adapter.connect(curator).removeLiquidity(euruPool, shares, [0n, 0n]);
			const receipt = await tx.wait();

			const logs = receipt!.logs.map((log) => {
				try {
					return adapter.interface.parseLog(log);
				} catch {
					return null;
				}
			});
			const removeEvent = logs.find((e) => e?.name === 'RemoveLiquidity')!;
			const repayEvent = logs.find((e) => e?.name === 'RepayDebt')!;

			expect(await euruPool.balanceOf(adapter)).to.equal(adapterLP - shares);

			// removed a proportional (1/4) slice of a balanced pool, well under outstanding debt, so the
			// whole withdrawal is consumed by debt repayment within the same tx — nothing left over for
			// the curator, and no balance is ever left sitting in the adapter between calls
			expect(repayEvent.args.repaidUsdu).to.equal(removeEvent.args.withdrawn[0]);
			expect(repayEvent.args.repaidOther).to.equal(removeEvent.args.withdrawn[1]);
			expect(await usdu.balanceOf(adapter)).to.equal(0n);
			expect(await euru.balanceOf(adapter)).to.equal(0n);
			expect(await usdu.balanceOf(curator)).to.equal(curatorUsduBefore);
			expect(await euru.balanceOf(curator)).to.equal(curatorEuruBefore);

			const debtAfter = await adapter.debts(euruPool);
			expect(debtAfter.usdu).to.equal(debtBefore.usdu - removeEvent.args.withdrawn[0]);
			expect(debtAfter.other).to.equal(debtBefore.other - removeEvent.args.withdrawn[1]);
		});

		it('rejects removeLiquidity from a non-curator caller', async function () {
			await expect(adapter.connect(other).removeLiquidity(euruPool, 1n, [0n, 0n])).to.be.revertedWithCustomError(
				usdu,
				'NotCuratorRole'
			);
		});

		it('rejects repayDebt from a non-curator caller', async function () {
			await expect(adapter.connect(other).repayDebt(euruPool)).to.be.revertedWithCustomError(usdu, 'NotCuratorRole');
		});

		it('repayDebt settles a direct top-up that never went through removeLiquidity', async function () {
			// still ~3/4 of the original debt outstanding at this point (only partially unwound above)
			const topUp = parseEther('10');
			await setERC20Balance(addr.euruStable, await adapter.getAddress(), topUp);

			const debtBefore = await adapter.debts(euruPool);
			expect(debtBefore.other).to.be.gt(topUp); // top-up alone shouldn't fully cover outstanding debt

			const tx = await adapter.connect(curator).repayDebt(euruPool);
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

			expect(repayEvent.args.repaidUsdu).to.equal(0n);
			expect(repayEvent.args.repaidOther).to.equal(topUp);
			expect(await euru.balanceOf(adapter)).to.equal(0n);

			const debtAfter = await adapter.debts(euruPool);
			expect(debtAfter.other).to.equal(debtBefore.other - topUp);
		});
		// EURU pool still has ~3/4 of its LP and debt outstanding at this point — kept that way
		// deliberately so 'cross-pool isolation' below can exercise it alongside a freshly-seeded CHFU
		// pool; the full unwind of what's left happens last, in 'USDU/EURU pool cleanup'.
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

	describe('cross-pool isolation', function () {
		// by this point both EURU and CHFU pools have been seeded (in the describe blocks above) and
		// each still carries outstanding USDU debt — exactly the scenario where a shared token.balanceOf
		// would previously let settling one pool's debt consume balance meant for the other's.
		it("doesn't let settling one pool's debt touch balance withdrawn for a different pool", async function () {
			const chfuDebtBefore = await adapter.debts(chfuPool);
			expect(chfuDebtBefore.usdu).to.be.gt(0n);

			// unwind (part of) the EURU pool — this settles EURU's own debt atomically within the same
			// call and must leave the adapter's usdu/chfu balance, and CHFU's tracked debt, untouched
			const euruAdapterLP = await euruPool.balanceOf(adapter);
			await adapter.connect(curator).removeLiquidity(euruPool, euruAdapterLP / 2n, [0n, 0n]);

			expect(await usdu.balanceOf(adapter)).to.equal(0n);
			expect(await chfu.balanceOf(adapter)).to.equal(0n);

			const chfuDebtAfter = await adapter.debts(chfuPool);
			expect(chfuDebtAfter.usdu).to.equal(chfuDebtBefore.usdu);
			expect(chfuDebtAfter.other).to.equal(chfuDebtBefore.other);
		});
	});

	describe('USDU/EURU pool cleanup', function () {
		it('forwards surplus beyond debt to the curator on a full unwind', async function () {
			const debtBefore = await adapter.debts(euruPool);
			const adapterLP = await euruPool.balanceOf(adapter);

			const curatorUsduBefore = await usdu.balanceOf(curator);
			const curatorEuruBefore = await euru.balanceOf(curator);

			const tx = await adapter.connect(curator).removeLiquidity(euruPool, adapterLP, [0n, 0n]);
			const receipt = await tx.wait();
			const withdrawn = receipt!.logs
				.map((log) => {
					try {
						return adapter.interface.parseLog(log);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'RemoveLiquidity')!.args.withdrawn;

			const debtAfter = await adapter.debts(euruPool);
			expect(debtAfter.usdu).to.equal(0n);
			expect(debtAfter.other).to.equal(0n);
			expect(await usdu.balanceOf(adapter)).to.equal(0n);
			expect(await euru.balanceOf(adapter)).to.equal(0n);

			// anything withdrawn beyond the remaining debt (e.g. LP fee growth) went to the curator
			const expectedSurplusUsdu = withdrawn[0] > debtBefore.usdu ? withdrawn[0] - debtBefore.usdu : 0n;
			const expectedSurplusEuru = withdrawn[1] > debtBefore.other ? withdrawn[1] - debtBefore.other : 0n;
			expect(await usdu.balanceOf(curator)).to.equal(curatorUsduBefore + expectedSurplusUsdu);
			expect(await euru.balanceOf(curator)).to.equal(curatorEuruBefore + expectedSurplusEuru);
		});
	});
});
