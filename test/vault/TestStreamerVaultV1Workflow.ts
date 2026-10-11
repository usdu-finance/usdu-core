import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { formatEther, parseEther } from 'viem';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * Walks through a full streaming lifecycle and prints a table of the vault state after every step.
 *
 *   duration = 1000s, alice stakes 1000, rewards of 100 are sent twice (t=0 and t=500).
 *   The 2nd top-up merges with the 50 still locked: end time = weighted average of (50 over 500s) and (100 over 1000s).
 */
describe('StreamerVaultV1 workflow', function () {
	const DURATION = 1000;
	let token: any, vault: any;
	let alice: SignerWithAddress, bob: SignerWithAddress;
	let t0: number;

	const rows: Record<string, string>[] = [];
	const f = (v: bigint, d = 2) => Number(formatEther(v)).toFixed(d);

	const snapshot = async (event: string) => {
		const now = await time.latest();
		const [locked, assets, pending, price, aShares, bShares, rate] = await Promise.all([
			vault.locked(),
			vault.totalAssets(),
			vault.pending(),
			vault.price(),
			vault.balanceOf(alice.address),
			vault.balanceOf(bob.address),
			vault.rate(),
		]);
		const [aAssets, bAssets] = await Promise.all([vault.convertToAssets(aShares), vault.convertToAssets(bShares)]);
		const end = Number(await vault.streamEnd());
		rows.push({
			't': String(now - t0),
			'event': event,
			'end in': String(Math.max(end - now, 0)),
			'rate/s': f(rate, 4),
			'pending': f(pending),
			'locked': f(locked),
			'totalAssets': f(assets),
			'price': f(price, 4),
			'alice': f(aAssets),
			'bob': f(bAssets),
		});
	};

	/** run `action` in a block with timestamp t0 + at (or just mine a block there), then record a table row */
	const step = async (at: number, event: string, action?: () => Promise<any>) => {
		await time.setNextBlockTimestamp(t0 + at);
		if (action) await action();
		else await ethers.provider.send('evm_mine', []);
		await snapshot(event);
	};

	before(async function () {
		[alice, bob] = await ethers.getSigners();
		token = await (await ethers.getContractFactory('TestToken')).deploy('USDU', 'USDU');
		vault = await (await ethers.getContractFactory('StreamerVaultV1')).deploy(token, DURATION, 'Streamer', 'sUSDU');
		for (const s of [alice, bob]) {
			await token.connect(s).mint(parseEther('10000'));
			await token.connect(s).approve(vault, ethers.MaxUint256);
		}
		t0 = (await time.latest()) + 10;
	});

	after(function () {
		console.log(`\nduration=${DURATION}s, amounts in USDU\n`);
		console.table(rows);
	});

	it('runs the full lifecycle', async function () {
		await step(0, 'alice deposits 1000', () => vault.deposit(parseEther('1000'), alice.address));

		// reward arrives as plain transfer: sits in `pending`, not yet in totalAssets
		await step(10, 'transfer 100 (unsynced)', () => token.transfer(vault, parseEther('100')));
		await step(20, 'sync() -> stream starts', () => vault.sync());

		await step(270, 'idle');
		await step(520, 'idle');

		// bob joins at price ~1.05 and 2nd reward arrives, auto-synced by his deposit
		await step(530, 'transfer 100 (unsynced)', () => token.transfer(vault, parseEther('100')));
		await step(540, 'bob deposits 1050 (auto-sync)', async () => {
			const p = await vault.price();
			await vault.connect(bob).deposit((p * 1000n) / 1n, bob.address); // 1000 shares worth at current price
		});

		await step(800, 'idle');
		await step(1100, 'idle');
		await step(1500, 'idle');
		await step(1700, 'stream over, flat');
		await step(3000, 'long after, flat');

		await step(3010, 'alice redeems all', async () =>
			vault.redeem(await vault.balanceOf(alice.address), alice.address, alice.address)
		);
		await step(3020, 'bob redeems all', async () =>
			vault.connect(bob).redeem(await vault.balanceOf(bob.address), bob.address, bob.address)
		);

		// closed economy (alice funded both rewards from her own wallet): nothing created, at most dust left behind
		const aliceBal = await token.balanceOf(alice.address);
		const bobBal = await token.balanceOf(bob.address);
		expect(aliceBal + bobBal).to.be.closeTo(parseEther('20000'), 5n);
		expect(await token.balanceOf(vault)).to.be.lt(10n);
		expect(await vault.locked()).to.equal(0n);

		// bob joined at ~1.05 and earned from the later stream only: ~74 on ~1051 staked
		expect(bobBal - parseEther('10000')).to.be.closeTo(parseEther('74'), parseEther('1'));

		// price is flat once the stream is over
		expect(rows[9].price).to.equal(rows[11].price);
		// price never decreased
		for (let i = 1; i < rows.length - 1; i++) expect(Number(rows[i].price)).to.be.gte(Number(rows[i - 1].price));
	});
});
