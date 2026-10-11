import { expect } from 'chai';
import { ethers } from 'hardhat';
import { parseEther } from 'viem';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { evm_increaseTime } from '../helper';

describe('StreamerVaultV1', function () {
	const DURATION = 1000n;
	let token: any, vault: any;
	let alice: SignerWithAddress, bob: SignerWithAddress;

	beforeEach(async function () {
		[alice, bob] = await ethers.getSigners();
		token = await (await ethers.getContractFactory('TestToken')).deploy('USDU', 'USDU');
		vault = await (await ethers.getContractFactory('StreamerVaultV1')).deploy(token, DURATION, 'Streamer', 'sUSDU');
		await token.mint(parseEther('10000'));
		await token.connect(bob).mint(parseEther('10000'));
		await token.approve(vault, ethers.MaxUint256);
		await token.connect(bob).approve(vault, ethers.MaxUint256);
	});

	it('does not stream without stakers', async function () {
		await token.transfer(vault, parseEther('100'));
		await vault.sync();
		expect(await vault.locked()).to.equal(0n);
		expect(await vault.pending()).to.equal(parseEther('100'));
	});

	it('streams linearly to stakers', async function () {
		await vault.deposit(parseEther('1000'), alice.address);
		await token.transfer(vault, parseEther('100'));
		await vault.sync();
		expect(await vault.totalAssets()).to.be.closeTo(parseEther('1000'), parseEther('0.2'));

		await evm_increaseTime(500);
		expect(await vault.totalAssets()).to.be.closeTo(parseEther('1050'), parseEther('0.2'));

		await evm_increaseTime(600);
		expect(await vault.totalAssets()).to.equal(parseEther('1100'));
		expect(await vault.maxWithdraw(alice.address)).to.be.closeTo(parseEther('1100'), 2n);
	});

	it('late staker does not capture streamed rewards', async function () {
		await vault.deposit(parseEther('1000'), alice.address);
		await token.transfer(vault, parseEther('100'));
		await vault.sync();
		await evm_increaseTime(500);
		await vault.connect(bob).deposit(parseEther('1050'), bob.address);
		await evm_increaseTime(600);
		// 50 left to stream, split 50/50
		expect(await vault.maxWithdraw(alice.address)).to.be.closeTo(parseEther('1075'), parseEther('0.5'));
		expect(await vault.maxWithdraw(bob.address)).to.be.closeTo(parseEther('1075'), parseEther('0.5'));
	});

	it('weights end time on top-up, dust cannot extend stream', async function () {
		await vault.deposit(parseEther('1000'), alice.address);
		await token.transfer(vault, parseEther('100'));
		await vault.sync();
		await evm_increaseTime(500);
		const endBefore = await vault.streamEnd();
		await token.transfer(vault, 1n);
		await vault.sync();
		const endAfter = await vault.streamEnd();
		expect(endAfter - endBefore).to.be.lte(2n);
	});

	it('plain transfer is streamed on next deposit, no price jump', async function () {
		await vault.deposit(parseEther('1000'), alice.address);
		await token.transfer(vault, parseEther('100'));
		expect(await vault.totalAssets()).to.equal(parseEther('1000'));
		await vault.connect(bob).deposit(parseEther('1000'), bob.address); // auto-sync
		expect(await vault.pending()).to.equal(0n);
		expect(await vault.locked()).to.be.gt(parseEther('99.9'));
		await evm_increaseTime(1100);
		expect(await vault.maxWithdraw(alice.address)).to.be.closeTo(parseEther('1050'), parseEther('0.5'));
	});

	it('fully redeems', async function () {
		await vault.deposit(parseEther('1000'), alice.address);
		await vault.redeem(await vault.balanceOf(alice.address), alice.address, alice.address);
		expect(await vault.totalAssets()).to.equal(0n);
	});

	describe('empty vault mid-stream', function () {
		beforeEach(async function () {
			await vault.deposit(parseEther('1000'), alice.address);
			await token.transfer(vault, parseEther('100'));
			await vault.sync();
			await evm_increaseTime(300);
			await vault.redeem(await vault.balanceOf(alice.address), alice.address, alice.address);
			await evm_increaseTime(400); // stream keeps unlocking with nobody staked
		});

		it('leaves supply 0 with unlocked assets and a running stream', async function () {
			expect(await vault.totalSupply()).to.equal(0n);
			expect(await vault.totalAssets()).to.be.closeTo(parseEther('40'), parseEther('0.5'));
			expect(await vault.locked()).to.be.closeTo(parseEther('30'), parseEther('0.5'));
		});

		it('first depositor gets 1:1 shares, not zero', async function () {
			expect(await vault.previewDeposit(parseEther('10'))).to.equal(parseEther('10'));
			expect(await vault.previewMint(parseEther('10'))).to.equal(parseEther('10'));
			await vault.connect(bob).deposit(parseEther('10'), bob.address);
			expect(await vault.balanceOf(bob.address)).to.equal(parseEther('10'));
		});

		it('first depositor owns the already-unlocked part and the rest of the stream', async function () {
			await vault.connect(bob).deposit(parseEther('10'), bob.address);
			expect(await vault.maxWithdraw(bob.address)).to.be.closeTo(parseEther('50'), parseEther('0.5'));
			await evm_increaseTime(1000);
			expect(await vault.maxWithdraw(bob.address)).to.be.closeTo(parseEther('80'), parseEther('0.5'));
			await vault.connect(bob).redeem(await vault.balanceOf(bob.address), bob.address, bob.address);
			expect(await token.balanceOf(vault)).to.be.lt(10n);
		});

		it('price shows 1.0 while empty', async function () {
			expect(await vault.price()).to.equal(parseEther('1'));
		});
	});
});
