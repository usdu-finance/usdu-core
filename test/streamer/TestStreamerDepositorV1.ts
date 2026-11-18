import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther } from 'viem';
import { mainnet } from 'viem/chains';

import { ADDRESS } from '../../exports/address.config';
import { StreamerDepositorV1, StreamerVaultV1, TestToken } from '../../typechain';
import { evm_increaseTime } from '../helper';

describe('StreamerDepositorV1', function () {
	const addr = ADDRESS[mainnet.id];
	const E18 = 10n ** 18n;
	const WEEK = 7n * 24n * 3600n;

	let dep: StreamerDepositorV1;
	let vault: StreamerVaultV1;
	let token: TestToken;
	let curator: SignerWithAddress;
	let deployer: SignerWithAddress;
	let caller: SignerWithAddress;
	let depAddr: string;
	let vaultAddr: string;
	let tokenAddr: string;

	before(async function () {
		[deployer, caller] = await ethers.getSigners();
		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		curator = await ethers.getSigner(addr.curator);
		await deployer.sendTransaction({ to: curator.address, value: parseEther('10') });

		token = await (await ethers.getContractFactory('TestToken')).deploy('Stable', 'STB');
		tokenAddr = await token.getAddress();
		vault = await (await ethers.getContractFactory('StreamerVaultV1')).deploy(tokenAddr, 30n * 24n * 3600n, 'Staked', 'sSTB');
		vaultAddr = await vault.getAddress();
		dep = await (await ethers.getContractFactory('StreamerDepositorV1')).deploy(addr.usduStable);
		depAddr = await dep.getAddress();

		// DAO holds 1,000,000, approves the depositor
		await token.connect(deployer).mint(1_000_000n * E18);
		await token.connect(deployer).transfer(curator.address, 1_000_000n * E18);
		await token.connect(curator).approve(depAddr, ethers.MaxUint256);

		// a staker so the vault accepts a stream
		await token.connect(deployer).mint(100n * E18);
		await token.connect(deployer).approve(vaultAddr, 100n * E18);
		await vault.connect(deployer).deposit(100n * E18, deployer.address);
	});

	it('only the curator configures, input is validated', async function () {
		await expect(dep.connect(caller).setFlow(tokenAddr, vaultAddr, 100, WEEK, E18)).to.be.reverted;
		await expect(dep.connect(curator).setFlow(tokenAddr, vaultAddr, 0, WEEK, E18)).to.be.revertedWithCustomError(dep, 'BadFlow');
		await expect(dep.connect(curator).setFlow(tokenAddr, vaultAddr, 10001, WEEK, E18)).to.be.revertedWithCustomError(dep, 'BadFlow');
		await expect(dep.connect(curator).setFlow(tokenAddr, vaultAddr, 100, 0, E18)).to.be.revertedWithCustomError(dep, 'BadFlow');
		await expect(dep.connect(curator).setFlow(tokenAddr, vaultAddr, 100, WEEK, 0)).to.be.revertedWithCustomError(dep, 'BadFlow');
		// vault asset mismatch
		await expect(dep.connect(curator).setFlow(addr.usduStable, vaultAddr, 100, WEEK, E18)).to.be.revertedWithCustomError(dep, 'BadFlow');
	});

	it('reverts while no flow is set', async function () {
		await expect(dep.connect(caller).deposit(tokenAddr)).to.be.revertedWithCustomError(dep, 'FlowNotEnabled');
	});

	it('percentage below cap, then cap applies, cooldown enforced', async function () {
		// 1% of 1,000,000 = 10,000, cap 6,000 -> cap wins
		await dep.connect(curator).setFlow(tokenAddr, vaultAddr, 100, WEEK, 6_000n * E18);
		expect(await dep.depositable(tokenAddr)).to.equal(6_000n * E18);

		await expect(dep.connect(caller).deposit(tokenAddr))
			.to.emit(dep, 'Expense')
			.withArgs(tokenAddr, vaultAddr, 6_000n * E18, 6_000n * E18, 994_000n * E18);
		expect(await token.balanceOf(curator.address)).to.equal(994_000n * E18);
		expect(await vault.totalFunded()).to.equal(6_000n * E18);
		expect(await token.balanceOf(depAddr)).to.equal(0);

		await expect(dep.connect(caller).deposit(tokenAddr)).to.be.revertedWithCustomError(dep, 'CooldownActive');
		expect(await dep.depositable(tokenAddr)).to.equal(0);

		await evm_increaseTime(WEEK);
		// 1% of 994,000 = 9,940, still above cap
		expect(await dep.depositable(tokenAddr)).to.equal(6_000n * E18);

		// raise the cap: percentage wins, and reconfiguring keeps the cooldown clock
		await dep.connect(curator).setFlow(tokenAddr, vaultAddr, 100, WEEK, 50_000n * E18);
		expect(await dep.depositable(tokenAddr)).to.equal(9_940n * E18);
		await dep.connect(caller).deposit(tokenAddr);
		expect((await dep.getFlow(tokenAddr)).totalDeposited).to.equal(15_940n * E18);
	});

	it('clamps to the DAO allowance', async function () {
		await evm_increaseTime(WEEK);
		await token.connect(curator).approve(depAddr, 123n * E18);
		expect(await dep.depositable(tokenAddr)).to.equal(123n * E18);
		await token.connect(curator).approve(depAddr, 0);
		await expect(dep.connect(caller).deposit(tokenAddr)).to.be.revertedWithCustomError(dep, 'NothingToDeposit');
		await token.connect(curator).approve(depAddr, ethers.MaxUint256);
	});

	it('guardian can disable, caller cannot', async function () {
		await expect(dep.connect(caller).disableFlow(tokenAddr)).to.be.reverted;
		await dep.connect(curator).disableFlow(tokenAddr);
		expect(await dep.depositable(tokenAddr)).to.equal(0);
		await expect(dep.connect(caller).deposit(tokenAddr)).to.be.revertedWithCustomError(dep, 'FlowNotEnabled');
	});

	it('does nothing while the vault has no stakers', async function () {
		const v2 = await (await ethers.getContractFactory('StreamerVaultV1')).deploy(tokenAddr, WEEK, 'S2', 'S2');
		await dep.connect(curator).setFlow(tokenAddr, await v2.getAddress(), 100, WEEK, E18);
		expect(await dep.depositable(tokenAddr)).to.equal(0);
		await expect(dep.connect(caller).deposit(tokenAddr)).to.be.revertedWithCustomError(dep, 'NothingToDeposit');
	});
});
