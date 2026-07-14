import { expect } from 'chai';
import { ethers } from 'hardhat';
import {
	ERC20,
	IMetaMorphoV1_1,
	IMetaMorphoV1_1Factory,
	TestToken,
	MorphoAdapterV1,
	RewardRouterV0,
	Stablecoin,
	VaultDeployer,
} from '../../typechain';
import { IMorpho } from '../../typechain/contracts/morpho/helpers/IMorpho.sol/IMorpho';
import { IMorpho__factory } from '../../typechain/factories/contracts/morpho/helpers/IMorpho.sol/IMorpho__factory';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ADDRESS } from '../../exports/address.config';
import { mainnet } from 'viem/chains';
import { Address, parseEther, parseUnits, zeroAddress } from 'viem';
import { MarketParamsStruct } from '../../typechain/contracts/deploy/VaultDeployer';
import { BytesLike } from 'ethers';
import { evm_increaseTime } from '../helper';

describe('Deploy Stablecoin', function () {
	const addr = ADDRESS[mainnet.id];

	let vaultDeployer: VaultDeployer;
	let stable: Stablecoin;
	let marketIdle: MarketParamsStruct;

	let testToken: TestToken;
	let market: MarketParamsStruct;
	let marketId: BytesLike;

	let morpho: IMorpho;

	let core: IMetaMorphoV1_1;
	let staked: IMetaMorphoV1_1;
	let adapter: MorphoAdapterV1;
	let reward: RewardRouterV0;

	let curator: SignerWithAddress;
	let user: SignerWithAddress;
	let module: SignerWithAddress;

	const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
	const MORPHO_IRM = '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC';
	const MORPHO_META_MORPHO_FACTORY_1_1 = '0x1897A8997241C1cD4bD0698647e4EB7213535c24';
	const MORPHO_PUBLIC_ALLOCATOR = '0xfd32fA2ca22c76dD6E550706Ad913FC6CE91c75D';
	const MORPHO_URD = '0x330eefa8a787552DC5cAd3C3cA644844B1E61Ddb';

	before(async function () {
		[curator, user, module] = await ethers.getSigners();

		morpho = IMorpho__factory.connect(MORPHO_BLUE, curator);

		const VaultDeployer = await ethers.getContractFactory('VaultDeployer');
		vaultDeployer = await VaultDeployer.deploy(
			MORPHO_BLUE,
			MORPHO_META_MORPHO_FACTORY_1_1,
			MORPHO_PUBLIC_ALLOCATOR,
			MORPHO_URD,
			curator.address
		);

		stable = await ethers.getContractAt('Stablecoin', await vaultDeployer.stable());

		const TestToken = await ethers.getContractFactory('TestToken');
		testToken = await TestToken.deploy('Wrapped Token', 'WTKN');

		market = {
			loanToken: await stable.getAddress(),
			collateralToken: await testToken.getAddress(),
			oracle: '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a',
			irm: MORPHO_IRM,
			lltv: parseUnits('86', 16),
		};

		marketIdle = {
			loanToken: await stable.getAddress(),
			collateralToken: zeroAddress,
			oracle: zeroAddress,
			irm: zeroAddress,
			lltv: 0,
		};

		const tx = await morpho.createMarket(market);
		const receipt = await tx.wait();
		marketId = receipt!.logs[0].topics[1];

		core = await ethers.getContractAt('IMetaMorphoV1_1', await vaultDeployer.core());
		staked = await ethers.getContractAt('IMetaMorphoV1_1', await vaultDeployer.staked());

		adapter = await ethers.getContractAt('MorphoAdapterV1', await vaultDeployer.adapter());
		reward = await ethers.getContractAt('RewardRouterV0', await vaultDeployer.reward());

		await stable.acceptCurator();
		await core.acceptOwnership();
		await staked.acceptOwnership();
	});

	describe('Mint fresh stables and deposit into vault', function () {
		it('Should correctly call deposit with 1M', async function () {
			await adapter.connect(curator).deposit(parseEther('1000000'));
		});

		it('Should correctly update totalMinted in adapter to 1M', async function () {
			expect(await adapter.totalMinted()).to.be.equal(parseEther('1000000'));
		});

		it('Should correctly reflect 1M as totalAssets in adapter', async function () {
			expect(await adapter.totalAssets()).to.be.equal(parseEther('1000000'));
		});

		it('Should correctly reflect 1M as totalAssets in core vault', async function () {
			expect(await core.totalAssets()).to.be.equal(parseEther('1000000'));
		});

		it('Should keep core vault totalAssets equal to 1M after repeated check', async function () {
			expect(await core.totalAssets()).to.be.equal(parseEther('1000000'));
		});

		it('Should reflect adapter balance in staked token as 1M', async function () {
			expect(await staked.balanceOf(await adapter.getAddress())).to.be.equal(parseEther('1000000'));
		});
	});

	describe('Redeem and pay off debt from vault', function () {
		it('Should correctly call redeem with 1M', async function () {
			await adapter.connect(curator).redeem(parseEther('1000000'));
		});

		it('Should correctly update totalMinted in adapter to 0', async function () {
			expect(await adapter.totalMinted()).to.be.equal(parseEther('0'));
		});

		it('Should correctly reflect 0 totalAssets in adapter after redemption', async function () {
			expect(await adapter.totalAssets()).to.be.equal(parseEther('0'));
		});

		it('Should correctly reflect 0 totalAssets in core vault after redemption', async function () {
			expect(await core.totalAssets()).to.be.equal(parseEther('0'));
		});

		it('Should correctly reflect 0 totalAssets in staked vault after redemption', async function () {
			expect(await staked.totalAssets()).to.be.equal(parseEther('0'));
		});
	});

	describe('Borrow sequence', function () {
		it('Should correctly set up test market', async function () {
			await core.connect(curator).submitCap(market, parseEther('10000000'));
			await core.connect(curator).acceptCap(market);
			await core
				.connect(curator)
				.setSupplyQueue([await vaultDeployer.getMarketId(market), await vaultDeployer.getMarketId(marketIdle)]);

			await core.connect(curator).updateWithdrawQueue([1, 0]);

			await adapter.connect(curator).deposit(parseEther('1000000'));

			// await core.connect(curator).reallocate([
			// 	{
			// 		marketParams: market,
			// 		assets: parseEther('9000000'),
			// 	},
			// 	{
			// 		marketParams: marketIdle,
			// 		assets: parseEther('1000000'),
			// 	},
			// ]);
		});

		const collatealAmount = parseUnits('10', 18); // @dev: somehow the price is around 1080 WTKN / Stable
		const borrowAmount = parseUnits('1000', 18); // lltv: 86% --> around 930 WTKN / Stable
		it('Should correctly mint test collateral', async function () {
			await testToken.connect(user).mint(collatealAmount);
			expect(await testToken.balanceOf(user)).to.be.equal(collatealAmount);
		});

		it('Should correctly approve collateral and supplyCollateral', async function () {
			await testToken.connect(user).approve(await morpho.getAddress(), collatealAmount);
			await morpho.connect(user).supplyCollateral(market, collatealAmount, user, Buffer.from(''));
			expect((await morpho.position(marketId, user)).collateral).to.be.equal(collatealAmount);
		});

		it('Should correctly borrow against collateral', async function () {
			await morpho.connect(user).borrow(market, borrowAmount, 0, user, user);
			expect(await stable.balanceOf(user)).to.be.equal(borrowAmount);
		});

		it('Should correctly wait 365 days and reconcile', async function () {
			await evm_increaseTime(365 * 24 * 60 * 60);
			const tx = await adapter.reconcile();
			const receipt = await tx.wait();
			// @ts-ignore
			const revenue = receipt!.logs[1].args;
			// @ts-ignore
			const distribution = receipt!.logs[3].args;
			expect(revenue[0]).to.be.equal(distribution[1]);
		});

		it('Should correctly deposit more and borrow more', async function () {
			await evm_increaseTime(365 * 24 * 60 * 60);
			await adapter.connect(curator).deposit(parseEther('1000000'));
			await morpho.connect(user).borrow(market, borrowAmount, 0, user, user);
		});

		it('Should correctly reconcile', async function () {
			await evm_increaseTime(365 * 24 * 60 * 60);
			const tx = await adapter.reconcile();
			const receipt = await tx.wait();
			// @ts-ignore
			const revenue = receipt!.logs[1].args;
			// @ts-ignore
			const distribution = receipt!.logs[3].args;
			expect(revenue[0]).to.be.equal(distribution[1]);
		});

		it('Should correctly ', async function () {
			await evm_increaseTime(365 * 24 * 60 * 60);
			const tx = await adapter.redeem(parseUnits('1000', 18));
			const receipt = await tx.wait();
			const logs = receipt!.logs;

			expect(logs[1].topics[0]).to.be.equal('0x704210ad0e772a9d53df2583519901ff427ae202d6faf3d36e4432740c711244'); // Revenue Event
			expect(logs[3].topics[0]).to.be.equal('0xa8ee3e5c0b1fd681042265199e8b28cf463b81bc21f6658d4c73e741aeabd3f5'); // Distribute Event
		});

		it('Should correctly test setDistribution and revoke', async function () {
			await expect(adapter.applyDistribution()).to.be.revertedWithCustomError(adapter, 'NoPendingValue');

			await adapter
				.connect(curator)
				.setDistribution([curator.address, zeroAddress, zeroAddress, zeroAddress, zeroAddress], [1000, 0, 0, 0, 0]);

			await expect(adapter.applyDistribution()).to.be.revertedWithCustomError(adapter, 'TimelockNotElapsed');

			await adapter.connect(curator).revokePendingDistribution();
		});

		it('Should correctly test setDistribution', async function () {
			await evm_increaseTime(10 * 24 * 60 * 60);

			await expect(adapter.applyDistribution()).to.be.revertedWithCustomError(adapter, 'NoPendingValue');

			await adapter
				.connect(curator)
				.setDistribution([await reward.getAddress(), curator, zeroAddress, zeroAddress, zeroAddress], [1000, 1000, 0, 0, 0]);

			await expect(adapter.applyDistribution()).to.be.revertedWithCustomError(adapter, 'TimelockNotElapsed');

			await evm_increaseTime(10 * 24 * 60 * 60);
			await adapter.applyDistribution();
		});

		it('Should correctly reconcile two receivers', async function () {
			await evm_increaseTime(365 * 24 * 60 * 60);
			const tx = await adapter.reconcile();
			const receipt = await tx.wait();
			// @ts-ignore
			const revenue = receipt!.logs[1].args;
			// @ts-ignore
			const distribution1 = receipt!.logs[3].args;
			// @ts-ignore
			const distribution2 = receipt!.logs[5].args;

			console.log();
			expect(revenue[0]).to.approximately(distribution1[1] + distribution2[1], 1n);
		});

		// it('Should correctly reconcile twice', async function () {
		// 	evm_increaseTime(365 * 24 * 60 * 60);
		// await adapter.reconcileTwice(); // atomic check for line: 216

		/*
				// function does not exist, just for testing

				function reconcileTwice() external {
					_reconcile(totalAssets(), false);
					_reconcile(totalAssets(), false);
				}

				// testing this section of _reconcile()

				if (allowPassing) {
					return 0;
				} else {
					revert NothingToReconcile(assets, totalMinted); <---
				}

			*/
		// });
	});

	describe('should try to find edge cases', async function () {
		beforeEach(async function () {
			await stable.connect(curator).setModule(module, 9999999999999, 'minter');
			await evm_increaseTime(3600 * 24 * 7 + 1000);
			await stable.acceptModule(module);

			await stable.connect(module).mintModule(module, parseEther('1000000'));
			await stable.connect(module).approve(await core.getAddress(), parseEther('1000000'));
			await core.connect(module).deposit(parseEther('1000000'), module);
		});

		it('is the accounting correct and never falls back?', async function () {
			const show = async () => {
				console.log({
					assets: await adapter.totalAssets(),
					minted: await adapter.totalMinted(),
					rev: await adapter.totalRevenue(),
					market: await morpho.market(marketId),
				});
			};

			const collatealAmount = parseUnits('1', 18 + 9); // @dev: somehow the price is around 1080 WTKN / Stable
			const borrowAmount = parseUnits('28', 18 + 5);
			await testToken.connect(user).mint(collatealAmount);
			await testToken.connect(user).approve(await morpho.getAddress(), collatealAmount);
			await morpho.connect(user).supplyCollateral(market, collatealAmount, user, Buffer.from(''));
			await morpho.connect(user).borrow(market, borrowAmount, 0, user, user);
			// await show();

			await evm_increaseTime(3600 * 24 * 200);
			// await show();

			await stable.connect(module).mintModule(module, parseEther('10000000'));
			await stable.connect(module).approve(await core.getAddress(), parseEther('10000000'));
			await core.connect(module).deposit(parseEther('10000000'), module);
			// await show();

			await evm_increaseTime(3600 * 24 * 10);
			await adapter.connect(curator).redeem((await staked.balanceOf(await adapter.getAddress())) / 2n);
			// await show();

			await evm_increaseTime(3600 * 24 * 10);
			await adapter.connect(curator).redeem(await staked.balanceOf(await adapter.getAddress()));
			// await show();

			await adapter.connect(curator).deposit(parseUnits('1', 18 + 6));
			await evm_increaseTime(3600 * 24 * 10);

			await stable.connect(module).mintModule(adapter, parseEther('10000'));
			await adapter.connect(curator).redeem(await staked.balanceOf(await adapter.getAddress()));

			expect(await core.balanceOf(await adapter.getAddress())).to.be.equal(0n);
			expect(await staked.balanceOf(await adapter.getAddress())).to.be.equal(0n);
		});
	});
});
