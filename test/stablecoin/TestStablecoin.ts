import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Stablecoin } from '../../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { evm_increaseTime, getTimeStamp } from '../helper';
import { parseEther } from 'viem';

describe('Deploy Stablecoin', function () {
	let stable: Stablecoin;
	let curator: SignerWithAddress;
	let guardian: SignerWithAddress;
	let moduleInit: SignerWithAddress;
	let module: SignerWithAddress;
	let user: SignerWithAddress;

	const timelock = 60 * 60 * 24 * 7;
	const expiredAt = 999999999999;
	const publicFee = parseEther('10000');

	const MIN_TIMELOCK = 60 * 60 * 24 * 7;
	const MAX_TIMELOCK = 60 * 60 * 24 * 30;
	const INCREASED_TIMELOCK = 60 * 60 * 24;
	const DECREASED_TIMELOCK = 60 * 60 * 24;

	beforeEach(async function () {
		[curator, guardian, moduleInit, module, user] = await ethers.getSigners();

		const Stablecoin = await ethers.getContractFactory('Stablecoin');
		stable = await Stablecoin.deploy('USDU', 'USDU', curator.address);

		await stable.connect(curator).setModule(moduleInit, expiredAt, 'moduleInit');
		await stable.connect(moduleInit).mintModule(user, publicFee * 2n);

		await stable.setTimelock(timelock);
		await stable.setGuardian(guardian);
	});

	describe('Role Checks, Curator Role', function () {
		it('Should correctly assigned curator role', async function () {
			expect(await stable.curator()).to.equal(curator.address);
		});

		//

		it('Should correctly checkCurator role', async function () {
			expect(await stable.checkCurator(curator.address)).to.equal(true);
		});

		//

		it('Should correctly verifyCurator role', async function () {
			expect(await stable.verifyCurator(curator.address)).to.not.be.reverted;
		});

		it('Should correctly verifyCuratorOrGuardian role', async function () {
			expect(await stable.verifyCuratorOrGuardian(curator.address)).to.not.be.reverted;
		});

		it('Should revert verifyGuardian role', async function () {
			await expect(stable.verifyGuardian(curator.address)).to.be.reverted;
		});

		it('Should revert verifyModule role', async function () {
			await expect(stable.verifyModule(curator.address)).to.be.reverted;
		});

		it('Should revert verifyValidModule role', async function () {
			await expect(stable.verifyValidModule(curator.address)).to.be.reverted;
		});
	});

	describe('setFreeze', function () {
		it('should freeze account', async function () {
			await expect(stable.connect(curator).setFreeze(user.address, 'Suspicious activity'))
				.to.emit(stable, 'SetFreeze')
				.withArgs(curator.address, user.address, 'Suspicious activity');

			const freezeTime = await stable.unfreeze(user.address);
			expect(freezeTime).to.be.gt(0);
		});

		it('should block transfers from freezed account', async function () {
			await expect(stable.connect(curator).setFreeze(user.address, 'Suspicious activity'))
				.to.emit(stable, 'SetFreeze')
				.withArgs(curator.address, user.address, 'Suspicious activity');

			await expect(stable.connect(user).transfer(curator, parseEther('1000')))
				.to.be.revertedWithCustomError(stable, 'AccountFreezed')
				.withArgs(user.address, await stable.unfreeze(user));
		});

		it('should revert if already frozen', async function () {
			await stable.connect(curator).setFreeze(user.address, 'First');
			await expect(stable.connect(curator).setFreeze(user.address, 'Second')).to.be.revertedWithCustomError(stable, 'AlreadySet');
		});
	});

	describe('setUnfreeze', function () {
		beforeEach(async function () {
			await stable.connect(curator).setFreeze(user.address, 'Reason');
		});

		it('should set pending unfreeze', async function () {
			await expect(stable.connect(guardian).setUnfreeze(user.address, 'Start unfreeze')).to.emit(stable, 'SubmitUnfreeze');

			const pending = await stable.pendingUnfreeze(user.address);
			expect(pending.validAt).to.be.gt(0);
		});

		it('should revert if not frozen', async function () {
			await expect(stable.connect(guardian).setUnfreeze(user.address, 'Start unfreeze')).to.emit(stable, 'SubmitUnfreeze');
			await evm_increaseTime(2 * timelock + 1000);

			await stable.connect(curator).acceptUnfreeze(user.address); // unfreeze
			await expect(stable.connect(guardian).setUnfreeze(user.address, 'Fail')).to.be.revertedWithCustomError(stable, 'AlreadySet');
		});

		it('should revert if already pending', async function () {
			await stable.connect(guardian).setUnfreeze(user.address, 'Pending');
			await expect(stable.connect(guardian).setUnfreeze(user.address, 'Again')).to.be.revertedWithCustomError(
				stable,
				'AlreadyPending'
			);
		});
	});

	describe('revokePendingUnfreeze', function () {
		beforeEach(async function () {
			await stable.connect(curator).setFreeze(user.address, 'Frozen');
			await stable.connect(guardian).setUnfreeze(user.address, 'Start unfreeze');
		});

		it('should revoke pending unfreeze', async function () {
			await expect(stable.connect(guardian).revokePendingUnfreeze(user.address, 'Mistake')).to.emit(stable, 'RevokeUnfreeze');

			const pending = await stable.pendingUnfreeze(user.address);
			expect(pending.validAt).to.equal(0);
		});

		it('should revert if no pending unfreeze', async function () {
			await stable.connect(guardian).revokePendingUnfreeze(user.address, 'One');
			await expect(stable.connect(guardian).revokePendingUnfreeze(user.address, 'Two')).to.be.revertedWithCustomError(
				stable,
				'NoPendingValue'
			);
		});
	});

	describe('acceptUnfreeze', function () {
		beforeEach(async function () {
			await stable.connect(curator).setFreeze(user.address, 'Frozen');
			await stable.connect(guardian).setUnfreeze(user.address, 'Request unfreeze');

			// Fast forward time
			await ethers.provider.send('evm_increaseTime', [timelock * 2 + 1]);
			await ethers.provider.send('evm_mine');
		});

		it('should accept unfreeze after timelock', async function () {
			await expect(stable.connect(user).acceptUnfreeze(user.address)).to.emit(stable, 'SetUnfreeze');

			const freezeTime = await stable.unfreeze(user.address);
			expect(freezeTime).to.equal(0);

			const pending = await stable.pendingUnfreeze(user.address);
			expect(pending.validAt).to.equal(0);
		});
	});

	describe('setModulePublic', function () {
		it('should revert with ERC20InsufficientBalance', async function () {
			await expect(
				stable.connect(guardian).setModulePublic(module.address, expiredAt, 'Add module with no fees to revert', publicFee)
			).to.be.revertedWithCustomError(stable, 'ERC20InsufficientBalance');
		});

		it('should revert with ProposalFeeToLow', async function () {
			await expect(stable.connect(guardian).setModulePublic(module.address, expiredAt, 'Add module with low fees', publicFee / 10n))
				.to.be.revertedWithCustomError(stable, 'ProposalFeeToLow')
				.withArgs(publicFee);
		});

		it('should have fee in wallet', async function () {
			expect(await stable.balanceOf(user)).to.be.greaterThanOrEqual(publicFee);
		});

		it('should submit module with timelock', async function () {
			await expect(stable.connect(user).setModulePublic(module.address, expiredAt, 'Add module', publicFee))
				.to.emit(stable, 'SubmitModule')
				.withArgs(user.address, module.address, expiredAt, 'Add module', timelock * 2);

			const pending = await stable.pendingModules(module.address);
			expect(pending.validAt).to.be.gt(0);
			expect(pending.value).to.equal(expiredAt);
		});

		it('should revert if already set', async function () {
			await stable.connect(user).setModulePublic(module.address, expiredAt, 'First', publicFee);

			// Fast forward time to allow acceptance
			await ethers.provider.send('evm_increaseTime', [timelock * 2 + 1]);
			await ethers.provider.send('evm_mine');

			await stable.connect(user).acceptModule(module.address);

			await expect(stable.connect(user).setModulePublic(module.address, expiredAt, 'Again', publicFee)).to.be.revertedWithCustomError(
				stable,
				'AlreadySet'
			);
		});

		it('should revert if already pending', async function () {
			await stable.connect(user).setModulePublic(module.address, expiredAt, 'First', publicFee);

			await expect(
				stable.connect(user).setModulePublic(module.address, expiredAt + 1, 'Duplicate', publicFee)
			).to.be.revertedWithCustomError(stable, 'AlreadyPending');
		});
	});

	describe('revokePendingModule', function () {
		beforeEach(async function () {
			await stable.connect(user).setModulePublic(module.address, expiredAt, 'Init', publicFee);
		});

		it('should revoke a pending module', async function () {
			await expect(stable.connect(curator).revokePendingModule(module.address, 'Revoke it'))
				.to.emit(stable, 'RevokePendingModule')
				.withArgs(curator.address, module.address, 'Revoke it');

			const pending = await stable.pendingModules(module.address);
			expect(pending.validAt).to.equal(0);
		});

		it('should revert if no pending module', async function () {
			await stable.connect(curator).revokePendingModule(module.address, 'Revoke it');

			await expect(stable.connect(curator).revokePendingModule(module.address, 'Try again')).to.be.revertedWithCustomError(
				stable,
				'NoPendingValue'
			);
		});
	});

	describe('acceptModule', function () {
		let expiredAt: number;

		beforeEach(async function () {
			expiredAt = (await getTimeStamp()) ?? 0 + timelock * 4;
			await stable.connect(user).setModulePublic(module.address, expiredAt, 'Pending', publicFee);

			await ethers.provider.send('evm_increaseTime', [timelock * 2 + 1]);
			await ethers.provider.send('evm_mine');
		});

		it('should accept module after timelock', async function () {
			await expect(stable.connect(user).acceptModule(module.address))
				.to.emit(stable, 'SetModule')
				.withArgs(user.address, module.address);

			const mod = await stable.modules(module.address);
			expect(mod).to.equal(expiredAt);

			const pending = await stable.pendingModules(module.address);
			expect(pending.validAt).to.equal(0);
		});

		it('should expire', async function () {
			await expect(stable.connect(user).acceptModule(module.address))
				.to.emit(stable, 'SetModule')
				.withArgs(user.address, module.address);

			await evm_increaseTime(timelock * 2 + 1000);

			await expect(stable.verifyValidModule(module))
				.to.revertedWithCustomError(stable, 'NotValidModuleRole')
				.withArgs(module.address);
		});
	});

	describe('setTimelock', function () {
		it('should immediately set a longer timelock', async function () {
			await expect(stable.connect(curator).setTimelock(timelock + INCREASED_TIMELOCK))
				.to.emit(stable, 'SetTimelock')
				.withArgs(curator.address, timelock + INCREASED_TIMELOCK);

			expect(await stable.timelock()).to.equal(timelock + INCREASED_TIMELOCK);
		});

		it('should create a pending timelock for lower value', async function () {
			await stable.connect(curator).setTimelock(timelock + INCREASED_TIMELOCK);

			await expect(stable.connect(curator).setTimelock(timelock))
				.to.emit(stable, 'SubmitTimelock')
				.withArgs(curator.address, timelock, timelock + INCREASED_TIMELOCK);

			const pending = await stable.pendingTimelock();
			expect(pending.validAt).to.be.gt(0);
			expect(pending.value).to.equal(timelock);
		});

		it('should revert if same timelock is set', async function () {
			await expect(stable.connect(curator).setTimelock(timelock)).to.be.revertedWithCustomError(stable, 'AlreadySet');
		});

		it('should revert if already pending', async function () {
			await stable.connect(curator).setTimelock(timelock + INCREASED_TIMELOCK);
			await stable.connect(curator).setTimelock(timelock);
			await expect(stable.connect(curator).setTimelock(timelock)).to.be.revertedWithCustomError(stable, 'AlreadyPending');
		});

		it('should revert if above max', async function () {
			await expect(stable.connect(curator).setTimelock(MAX_TIMELOCK + 1)).to.be.revertedWithCustomError(stable, 'AboveMaxTimelock');
		});

		it('should revert if below min', async function () {
			await expect(stable.connect(curator).setTimelock(MIN_TIMELOCK - 1)).to.be.revertedWithCustomError(stable, 'BelowMinTimelock');
		});
	});

	describe('revokePendingTimelock', function () {
		beforeEach(async function () {
			await stable.connect(curator).setTimelock(timelock + INCREASED_TIMELOCK);
			await stable.connect(curator).setTimelock(timelock);
		});

		it('should revoke pending timelock', async function () {
			await expect(stable.connect(guardian).revokePendingTimelock())
				.to.emit(stable, 'RevokePendingTimelock')
				.withArgs(guardian.address, timelock);

			const pending = await stable.pendingTimelock();
			expect(pending.validAt).to.equal(0);
		});

		it('should revert if no pending timelock', async function () {
			await stable.connect(guardian).revokePendingTimelock();
			await expect(stable.connect(guardian).revokePendingTimelock()).to.be.revertedWithCustomError(stable, 'NoPendingValue');
		});
	});

	describe('acceptTimelock', function () {
		beforeEach(async function () {
			await stable.connect(curator).setTimelock(timelock + INCREASED_TIMELOCK);
			await stable.connect(curator).setTimelock(timelock);
			await ethers.provider.send('evm_increaseTime', [timelock + INCREASED_TIMELOCK + 1]);
			await ethers.provider.send('evm_mine');
		});

		it('should accept pending timelock after timelock delay', async function () {
			await expect(stable.connect(user).acceptTimelock()).to.emit(stable, 'SetTimelock').withArgs(user.address, timelock);

			expect(await stable.timelock()).to.equal(timelock);
		});
	});
});
