import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { EuruDeployer, Stablecoin, SwapRouterV1, SwapBridgeMorphoV1, IERC20Metadata } from '../../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther, parseUnits } from 'viem';
import { setERC20Balance } from '../helper';

// The repo-wide fork block pinned in hardhat.config.ts predates this vault's deployment, so it doesn't exist
// there yet. Re-fork to a block it's live at, just for this suite, then reset back afterward so later test
// files still see the original pinned state they were written against.
const DEFAULT_FORK_BLOCK = 24244916;
const VAULT_FORK_BLOCK = 25000000;

const resetFork = (blockNumber: number) =>
	network.provider.request({
		method: 'hardhat_reset',
		params: [{ forking: { jsonRpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_RPC_KEY}`, blockNumber } }],
	});

describe('Deploy EuruDeployer', function () {
	// Steakhouse Prime EURC — a real, already-deployed Morpho Vault V2 wrapping EURC
	const VAULT = '0xbeef003E31546C7210687f1A7b40d096BE83ec58';

	const MINT_CAP = parseEther('10000000');
	const SWAP_IN_FEE_PPM = 1_000n; // 0.1%
	const SWAP_OUT_FEE_PPM = 1_000n; // 0.1%

	let euruDeployer: EuruDeployer;
	let stable: Stablecoin;
	let router: SwapRouterV1;
	let bridge: SwapBridgeMorphoV1;
	let coin: IERC20Metadata; // EURC

	let curator: SignerWithAddress;
	let distributor: SignerWithAddress;
	let user: SignerWithAddress;

	before(async function () {
		this.timeout(60_000);
		await resetFork(VAULT_FORK_BLOCK);
		// after a reset, ethers' fee estimation can still be primed from the old chain tip's base fee; mining a
		// block against the freshly-forked tip refreshes it before any transaction is sent
		await network.provider.send('evm_mine');

		[curator, distributor, user] = await ethers.getSigners();

		const EuruDeployer = await ethers.getContractFactory('EuruDeployer');
		euruDeployer = await EuruDeployer.deploy(curator.address, distributor.address, VAULT, MINT_CAP, SWAP_IN_FEE_PPM, SWAP_OUT_FEE_PPM);

		stable = await ethers.getContractAt('Stablecoin', await euruDeployer.stable());
		router = await ethers.getContractAt('SwapRouterV1', await euruDeployer.router());
		bridge = await ethers.getContractAt('SwapBridgeMorphoV1', await euruDeployer.bridge());
		coin = await ethers.getContractAt('IERC20Metadata', await bridge.coin());

		// fund the test user with EURC without needing to impersonate a whale
		await setERC20Balance(await coin.getAddress(), user.address, parseUnits('10000', 6));
	});

	after(async function () {
		this.timeout(60_000);
		await resetFork(DEFAULT_FORK_BLOCK);
	});

	describe('Deployment Sequence and Checks', function () {
		it('Should set the correct name and symbol', async function () {
			expect(await stable.name()).to.be.equal('EURU');
			expect(await stable.symbol()).to.be.equal('EURU');
		});

		it('Should wire the router to the stable', async function () {
			expect(await router.stable()).to.be.equal(await stable.getAddress());
		});

		it('Should wire the bridge to the stable and the given vault', async function () {
			expect(await bridge.stable()).to.be.equal(await stable.getAddress());
			expect(await bridge.vault()).to.be.equal(VAULT);
		});

		it('Should have derived EURC as the bridge coin from the vault', async function () {
			expect(await coin.symbol()).to.be.equal('EURC');
			expect(await coin.decimals()).to.be.equal(6);
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
		const AMOUNT_COIN = parseUnits('1000', 6); // 1000 EURC

		it('swaps EURC (6 decimals) into EURU (18 decimals) via swapIn', async function () {
			const coinBefore = await coin.balanceOf(user.address);
			const stableBefore = await stable.balanceOf(user.address);

			await coin.connect(user).approve(await router.getAddress(), AMOUNT_COIN);
			await router.connect(user).swapIn(await bridge.getAddress(), AMOUNT_COIN);

			const expectedStableGross = AMOUNT_COIN * 10n ** 12n; // 6 -> 18 decimals
			const fee = (expectedStableGross * SWAP_IN_FEE_PPM) / 1_000_000n;

			expect(await coin.balanceOf(user.address)).to.be.equal(coinBefore - AMOUNT_COIN);
			expect(await stable.balanceOf(user.address)).to.be.equal(stableBefore + expectedStableGross - fee);
		});

		it('swaps EURU (18 decimals) back into EURC (6 decimals) via swapOut', async function () {
			const amountStable = await stable.balanceOf(user.address);
			const coinBefore = await coin.balanceOf(user.address);

			await stable.connect(user).approve(await router.getAddress(), amountStable);
			await router.connect(user).swapOut(await bridge.getAddress(), amountStable);

			// the contract takes its fee in stable units first, then converts the remainder to coin decimals
			const feeStable = (amountStable * SWAP_OUT_FEE_PPM) / 1_000_000n;
			const expectedCoinNet = (amountStable - feeStable) / 10n ** 12n; // 18 -> 6 decimals

			expect(await stable.balanceOf(user.address)).to.be.equal(0n);
			expect(await coin.balanceOf(user.address)).to.be.equal(coinBefore + expectedCoinNet);
		});
	});
});
