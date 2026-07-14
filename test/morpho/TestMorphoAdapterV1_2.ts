import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import {
	ERC20,
	IMetaMorphoV1_1,
	IMetaMorphoV1_1Factory,
	IMorpho,
	TestToken,
	MorphoAdapterV1_2,
	Stablecoin,
	VaultDeployer,
} from '../../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ADDRESS } from '../../exports/address.config';
import { mainnet } from 'viem/chains';
import { Address, parseEther, parseUnits, zeroAddress } from 'viem';
import { MarketParamsStruct } from '../../typechain/contracts/deploy/VaultDeployer';
import { BytesLike } from 'ethers';
import { evm_increaseTime } from '../helper';

describe('Deploy Stablecoin', function () {
	const addr = ADDRESS[mainnet.id];

	let stable: Stablecoin;
	let marketIdle: MarketParamsStruct;

	let testToken: TestToken;
	let market: MarketParamsStruct;
	let marketId: BytesLike;

	let morpho: IMorpho;

	let core: IMetaMorphoV1_1;
	let adapter: MorphoAdapterV1_2;

	let curator: SignerWithAddress;
	let user: SignerWithAddress;
	let module: SignerWithAddress;

	const EXPIRED_AT = 999999999999n;
	const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
	const USDU_CORE_VAULT = '0xce22b5fb17ccbc0c5d87dc2e0df47dd71e3adc0a';

	before(async function () {
		[user, module] = await ethers.getSigners();

		// Impersonate USDC whale and curator
		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		curator = await ethers.getSigner(addr.curator);

		morpho = await ethers.getContractAt('IMorpho', MORPHO_BLUE);
		stable = await ethers.getContractAt('Stablecoin', addr.usduStable);
		core = await ethers.getContractAt('IMetaMorphoV1_1', USDU_CORE_VAULT);

		const Adapter = await ethers.getContractFactory('MorphoAdapterV1_2');
		adapter = await Adapter.deploy(
			addr.usduStable,
			USDU_CORE_VAULT,
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

		it('Should correctly reflect 1M as totalAssets in core vault', async function () {
			expect(await core.totalAssets()).to.be.greaterThanOrEqual(parseEther('1000000'));
		});
	});

	describe('Redeem and pay off debt from vault', function () {
		it('Should correctly call redeem with 1M', async function () {
			const shares = await core.balanceOf(await adapter.getAddress());
			await adapter.connect(curator).redeem(shares);
		});

		it('Should correctly update totalMinted in adapter to 0', async function () {
			expect(await adapter.totalMinted()).to.be.equal(parseEther('0'));
		});

		it('Should correctly reflect 0 totalAssets in adapter after redemption', async function () {
			expect(await adapter.totalAssets()).to.be.equal(parseEther('0'));
		});
	});
});
