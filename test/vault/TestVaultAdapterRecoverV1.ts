import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { Stablecoin, VaultAdapterRecoverV1 } from '../../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ADDRESS } from '../../exports/address.config';
import { mainnet } from 'viem/chains';
import { parseEther, zeroAddress } from 'viem';
import { evm_increaseTime } from '../helper';
import { IERC4626 } from '../../typechain/@openzeppelin/contracts/interfaces';

describe('Deploy Stablecoin', function () {
	const addr = ADDRESS[mainnet.id];
	const TERMMAX_VAULT = '0x18d91b5e3218ab16ef86fb7cb054cb48ba1e8b8e';

	let stable: Stablecoin;
	let vault: IERC4626;

	let adapter: VaultAdapterRecoverV1;

	let curator: SignerWithAddress;
	let user: SignerWithAddress;
	let module: SignerWithAddress;

	const EXPIRED_AT = 999999999999n;

	before(async function () {
		[user, module] = await ethers.getSigners();

		// Impersonate USDC whale and curator
		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		curator = await ethers.getSigner(addr.curator);

		stable = await ethers.getContractAt('Stablecoin', addr.usduStable);

		// @ts-ignore
		vault = await ethers.getContractAt('@openzeppelin/contracts/interfaces/IERC4626.sol:IERC4626', TERMMAX_VAULT);

		const Adapter = await ethers.getContractFactory('VaultAdapterRecoverV1');
		adapter = await Adapter.deploy(
			addr.usduStable,
			TERMMAX_VAULT,
			[addr.curator, zeroAddress, zeroAddress, zeroAddress, zeroAddress],
			[1000n, 0, 0, 0, 0]
		);

		// Fund curator
		await module.sendTransaction({ to: curator.address, value: parseEther('10') });

		// set module
		await stable.connect(curator).setModule(await adapter.getAddress(), EXPIRED_AT, 'adapter');
		await evm_increaseTime(7 * 24 * 3600 + 100); // Simulate module acceptance delay
		await stable.acceptModule(await adapter.getAddress());
	});

	describe('Mint fresh stables and deposit into vault', function () {
		it('Should correctly call deposit with 1M', async function () {
			await adapter.connect(curator).deposit(parseEther('1000000'));
		});

		it('Should correctly update totalMinted in adapter to 1M', async function () {
			expect(await adapter.totalMinted()).to.be.equal(parseEther('1000000'));
		});

		it('Should correctly reflect 1M as totalAssets in adapter', async function () {
			expect(await adapter.totalAssets()).to.be.approximately(parseEther('1000000'), 1n);
		});

		it('Should correctly reflect at least 1M as totalAssets in vault', async function () {
			expect(await vault.totalAssets()).to.be.greaterThanOrEqual(parseEther('1000000'));
		});
	});

	describe('Redeem and pay off debt from vault', function () {
		it('Should correctly call redeem all shares', async function () {
			const shares = await vault.balanceOf(await adapter.getAddress());
			await adapter.connect(curator).redeem(shares);
		});

		it('Should correctly update totalMinted in adapter to 0', async function () {
			expect(await adapter.totalMinted()).to.be.equal(parseEther('0'));
		});

		it('Should correctly reflect 0 totalAssets in adapter after redemption', async function () {
			expect(await adapter.totalAssets()).to.be.equal(parseEther('0'));
		});
	});

	describe('Edge Case: Claim collateral and manually swap to stable (over-coll.)', function () {
		it('Should correctly call deposit with 1M', async function () {
			await adapter.connect(curator).deposit(parseEther('1000000'));
			await evm_increaseTime(3600 * 24 * 100);
		});

		it('Should correctly recover all shares', async function () {
			await adapter.connect(curator).recoverAll(await vault.getAddress());
		});

		it('Should redeem all token as "sim" for a swap', async function () {
			await vault.connect(curator).redeem(await vault.balanceOf(curator.address), await adapter.getAddress(), curator.address);
		});

		it('Should correctly receive the stablecoin funds', async function () {
			const bal = await stable.balanceOf(await adapter.getAddress());
			expect(bal).to.be.greaterThanOrEqual(parseEther('1000000'));
		});

		it('Should correctly manually call redeem on adapter', async function () {
			await adapter.connect(curator).redeem(0);
		});

		it('Should correctly update totalMinted in adapter to 0', async function () {
			expect(await adapter.totalMinted()).to.be.equal(parseEther('0'));
		});

		it('Should correctly reflect 0 totalAssets in adapter after redemption', async function () {
			expect(await adapter.totalAssets()).to.be.equal(parseEther('0'));
		});

		it('Should correctly reflect 0 stables in adapter after redemption', async function () {
			expect(await stable.balanceOf(await adapter.getAddress())).to.be.equal(parseEther('0'));
		});
	});

	describe('Edge Case: Claim collateral and manually swap to stable (under-coll.)', function () {
		it('Should correctly call deposit with 1M', async function () {
			await adapter.connect(curator).deposit(parseEther('1000000'));
			await evm_increaseTime(3600 * 24 * 100);
		});

		it('Should correctly recover all shares', async function () {
			await adapter.connect(curator).recoverAll(await vault.getAddress());
		});

		it('Should redeem all token as "sim" for a swap', async function () {
			await vault.connect(curator).redeem(await vault.balanceOf(curator.address), curator.address, curator.address);
			await stable.connect(curator).transfer(await adapter.getAddress(), parseEther('800000'));

			console.log({
				curator: await stable.balanceOf(curator),
				adapter: await stable.balanceOf(await adapter.getAddress()),
			});
		});

		it('Should correctly receive the stablecoin funds', async function () {
			const bal = await stable.balanceOf(await adapter.getAddress());
			expect(bal).to.be.greaterThanOrEqual(parseEther('800000'));
		});

		it('Should correctly manually call redeem on adapter', async function () {
			await adapter.connect(curator).redeem(0);
		});

		it('Should correctly update totalMinted in adapter to greater then 0', async function () {
			expect(await adapter.totalMinted()).to.be.greaterThan(parseEther('0'));
		});

		it('Should correctly reflect 0 totalAssets in adapter after redemption', async function () {
			expect(await adapter.totalAssets()).to.be.equal(parseEther('0'));
		});

		it('Should correctly reflect 0 stables in adapter after redemption', async function () {
			expect(await stable.balanceOf(await adapter.getAddress())).to.be.equal(parseEther('0'));

			console.log({
				curator: await stable.balanceOf(curator),
				adapter: await stable.balanceOf(await adapter.getAddress()),
				minted: await adapter.totalMinted(),
			});
		});
	});
});
