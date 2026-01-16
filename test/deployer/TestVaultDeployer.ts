import { expect } from 'chai';
import { ethers } from 'hardhat';
import {
	IMetaMorphoV1_1,
	IMetaMorphoV1_1Factory,
	IMorpho,
	MorphoAdapterV1,
	RewardRouterV0,
	Stablecoin,
	VaultDeployer,
} from '../../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ADDRESS } from '../../exports/address.config';
import { mainnet } from 'viem/chains';
import { parseEther } from 'viem';

describe('Deploy VaultDeployer', function () {
	let vaultDeployer: VaultDeployer;
	let stable: Stablecoin;

	let core: IMetaMorphoV1_1;
	let staked: IMetaMorphoV1_1;
	let adapter: MorphoAdapterV1;
	let reward: RewardRouterV0;

	let curator: SignerWithAddress;
	let guardian: SignerWithAddress;
	let module: SignerWithAddress;

	before(async function () {
		[curator, guardian, module] = await ethers.getSigners();
		const addr = ADDRESS[mainnet.id];

		const VaultDeployer = await ethers.getContractFactory('VaultDeployer');
		vaultDeployer = await VaultDeployer.deploy(
			addr.morphoBlue,
			addr.morphoMetaMorphoFactory1_1,
			addr.morphoPublicAllocator,
			addr.morphoURD,
			curator.address
		);

		stable = await ethers.getContractAt('Stablecoin', await vaultDeployer.stable());

		core = await ethers.getContractAt('IMetaMorphoV1_1', await vaultDeployer.core());
		staked = await ethers.getContractAt('IMetaMorphoV1_1', await vaultDeployer.staked());

		adapter = await ethers.getContractAt('MorphoAdapterV1', await vaultDeployer.adapter());
		reward = await ethers.getContractAt('RewardRouterV0', await vaultDeployer.reward());
	});

	describe('Deployment Sequence and Checks', function () {
		it('Should correctly accept acceptOwnership of stable', async function () {
			await stable.acceptCurator();
			expect(await stable.curator()).to.be.equal(curator.address);
		});

		it('Should correctly accept acceptOwnership of core', async function () {
			await core.acceptOwnership();
			expect(await core.owner()).to.be.equal(curator.address);
		});

		it('Should correctly accept acceptOwnership of staked', async function () {
			await staked.acceptOwnership();
			expect(await staked.owner()).to.be.equal(curator.address);
		});
	});
});
