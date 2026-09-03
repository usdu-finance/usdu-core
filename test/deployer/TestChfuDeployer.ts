import { expect } from 'chai';
import { ethers } from 'hardhat';
import { ChfuDeployer, Stablecoin, SwapRouterV1, SwapBridgeMorphoV1, IERC20Metadata } from '../../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther, parseUnits } from 'viem';
import { setERC20Balance } from '../helper';

describe('Deploy ChfuDeployer', function () {
	// Frankencoin's SavingsVault (svZCHF) — a real, already-deployed ERC4626 vault wrapping ZCHF. Not a Morpho
	// vault, but SwapBridgeMorphoV1 only relies on the plain ERC4626 interface, so it works the same either way.
	const VAULT = '0xE5F130253fF137f9917C0107659A4c5262abf6b0';

	const MINT_CAP = parseEther('10000000');
	const SWAP_IN_FEE_PPM = 1_000n; // 0.1%
	const SWAP_OUT_FEE_PPM = 1_000n; // 0.1%

	let chfuDeployer: ChfuDeployer;
	let stable: Stablecoin;
	let router: SwapRouterV1;
	let bridge: SwapBridgeMorphoV1;
	let coin: IERC20Metadata; // ZCHF

	let curator: SignerWithAddress;
	let distributor: SignerWithAddress;
	let user: SignerWithAddress;

	before(async function () {
		[curator, distributor, user] = await ethers.getSigners();

		const ChfuDeployer = await ethers.getContractFactory('ChfuDeployer');
		chfuDeployer = await ChfuDeployer.deploy(curator.address, distributor.address, VAULT, MINT_CAP, SWAP_IN_FEE_PPM, SWAP_OUT_FEE_PPM);

		stable = await ethers.getContractAt('Stablecoin', await chfuDeployer.stable());
		router = await ethers.getContractAt('SwapRouterV1', await chfuDeployer.router());
		bridge = await ethers.getContractAt('SwapBridgeMorphoV1', await chfuDeployer.bridge());
		coin = await ethers.getContractAt('IERC20Metadata', await bridge.coin());

		// fund the test user with ZCHF without needing to impersonate a whale
		await setERC20Balance(await coin.getAddress(), user.address, parseUnits('10000', 18));
	});

	describe('Deployment Sequence and Checks', function () {
		it('Should set the correct name and symbol', async function () {
			expect(await stable.name()).to.be.equal('CHFU');
			expect(await stable.symbol()).to.be.equal('CHFU');
		});

		it('Should wire the router to the stable', async function () {
			expect(await router.stable()).to.be.equal(await stable.getAddress());
		});

		it('Should wire the bridge to the stable and the given vault', async function () {
			expect(await bridge.stable()).to.be.equal(await stable.getAddress());
			expect(await bridge.vault()).to.be.equal(VAULT);
		});

		it('Should have derived ZCHF as the bridge coin from the vault', async function () {
			expect(await coin.symbol()).to.be.equal('ZCHF');
			expect(await coin.decimals()).to.be.equal(18);
		});

		it('Should have registered the bridge as a valid module on the stable', async function () {
			expect(await stable.checkValidModule(await bridge.getAddress())).to.be.equal(true);
		});

		it('Should correctly accept acceptCurator of stable', async function () {
			await stable.connect(curator).acceptCurator();
			expect(await stable.curator()).to.be.equal(curator.address);
		});
	});

	describe('Swapping through the router', function () {
		const AMOUNT_COIN = parseUnits('1000', 18); // 1000 ZCHF

		it('swaps ZCHF (18 decimals) into CHFU (18 decimals) via swapIn', async function () {
			const coinBefore = await coin.balanceOf(user.address);
			const stableBefore = await stable.balanceOf(user.address);

			await coin.connect(user).approve(await router.getAddress(), AMOUNT_COIN);
			await router.connect(user).swapIn(await bridge.getAddress(), AMOUNT_COIN);

			const expectedStableGross = AMOUNT_COIN; // both 18 decimals, no scaling
			const fee = (expectedStableGross * SWAP_IN_FEE_PPM) / 1_000_000n;

			expect(await coin.balanceOf(user.address)).to.be.equal(coinBefore - AMOUNT_COIN);
			expect(await stable.balanceOf(user.address)).to.be.equal(stableBefore + expectedStableGross - fee);
		});

		it('swaps CHFU (18 decimals) back into ZCHF (18 decimals) via swapOut', async function () {
			const amountStable = await stable.balanceOf(user.address);
			const coinBefore = await coin.balanceOf(user.address);

			await stable.connect(user).approve(await router.getAddress(), amountStable);
			await router.connect(user).swapOut(await bridge.getAddress(), amountStable);

			// the contract takes its fee in stable units first, then converts the remainder to coin decimals
			const feeStable = (amountStable * SWAP_OUT_FEE_PPM) / 1_000_000n;
			const expectedCoinNet = amountStable - feeStable; // both 18 decimals, no scaling

			expect(await stable.balanceOf(user.address)).to.be.equal(0n);
			expect(await coin.balanceOf(user.address)).to.be.equal(coinBefore + expectedCoinNet);
		});
	});
});
