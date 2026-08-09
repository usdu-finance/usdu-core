import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { IERC20Metadata, Stablecoin, SwapBridgeMorphoV1, TestVault4626 } from '../../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ADDRESS } from '../../exports/address.config';
import { mainnet } from 'viem/chains';
import { parseEther, parseUnits, zeroAddress } from 'viem';
import { evm_increaseTime } from '../helper';

describe('SwapBridgeMorphoV1', function () {
	const addr = ADDRESS[mainnet.id];

	const USDC_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
	const USDC_HOLDER = '0x55fe002aeff02f77364de339a1292923a15844b8'; // Circle Reserve Wallet (or any whale)
	const EXPIRED_AT = 999999999999n;

	const MINT_CAP = parseEther('10000000');
	const SWAP_IN_FEE_PPM = 5_000n; // 0.5%
	const SWAP_OUT_FEE_PPM = 3_000n; // 0.3%

	let stable: Stablecoin;
	let usdc: IERC20Metadata;
	let vault: TestVault4626;
	let bridge: SwapBridgeMorphoV1;

	let curator: SignerWithAddress;
	let usdcUser: SignerWithAddress;
	let user: SignerWithAddress;
	let target: SignerWithAddress;
	let deployer: SignerWithAddress;

	let timelock: bigint;

	before(async function () {
		[deployer, user, target] = await ethers.getSigners();

		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [USDC_HOLDER] });
		usdcUser = await ethers.getSigner(USDC_HOLDER);

		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		curator = await ethers.getSigner(addr.curator);

		stable = await ethers.getContractAt('Stablecoin', addr.usduStable);
		usdc = await ethers.getContractAt('IERC20Metadata', USDC_TOKEN);
		timelock = await stable.timelock();

		const TestVault4626 = await ethers.getContractFactory('TestVault4626');
		vault = await TestVault4626.deploy(USDC_TOKEN);

		const SwapBridgeMorphoV1 = await ethers.getContractFactory('SwapBridgeMorphoV1');
		bridge = await SwapBridgeMorphoV1.deploy(
			addr.usduStable,
			USDC_TOKEN,
			await vault.getAddress(),
			MINT_CAP,
			SWAP_IN_FEE_PPM,
			SWAP_OUT_FEE_PPM
		);

		// fund curator with eth so it can send transactions
		await deployer.sendTransaction({ to: curator.address, value: parseEther('10') });

		// register bridge as a module on the stablecoin
		await stable.connect(curator).setModule(await bridge.getAddress(), EXPIRED_AT, 'swap-bridge-morpho');
		await evm_increaseTime(timelock + 100n);
		await stable.acceptModule(await bridge.getAddress());

		// fund the test users with USDC
		await usdc.connect(usdcUser).transfer(user, parseUnits('1000000', 6));
	});

	describe('Constructor', function () {
		it('reverts with InvalidFee when swapInFeePPM exceeds 100%', async function () {
			const Factory = await ethers.getContractFactory('SwapBridgeMorphoV1');
			await expect(
				Factory.deploy(addr.usduStable, USDC_TOKEN, await vault.getAddress(), MINT_CAP, 1_000_001, SWAP_OUT_FEE_PPM)
			).to.be.revertedWithCustomError(Factory, 'InvalidFee');
		});

		it('reverts with InvalidFee when swapOutFeePPM exceeds 100%', async function () {
			const Factory = await ethers.getContractFactory('SwapBridgeMorphoV1');
			await expect(
				Factory.deploy(addr.usduStable, USDC_TOKEN, await vault.getAddress(), MINT_CAP, SWAP_IN_FEE_PPM, 1_000_001)
			).to.be.revertedWithCustomError(Factory, 'InvalidFee');
		});

		it('reverts with InvalidVault when the vault asset does not match coin', async function () {
			const TestVault4626 = await ethers.getContractFactory('TestVault4626');
			const mismatchedVault = await TestVault4626.deploy(addr.usduStable); // asset() == stable, not USDC

			const Factory = await ethers.getContractFactory('SwapBridgeMorphoV1');
			await expect(
				Factory.deploy(
					addr.usduStable,
					USDC_TOKEN,
					await mismatchedVault.getAddress(),
					MINT_CAP,
					SWAP_IN_FEE_PPM,
					SWAP_OUT_FEE_PPM
				)
			).to.be.revertedWithCustomError(Factory, 'InvalidVault');
		});

		it('deploys correctly and exposes immutables', async function () {
			expect(await bridge.coin()).to.be.equal(USDC_TOKEN);
			expect(await bridge.vault()).to.be.equal(await vault.getAddress());
			expect(await bridge.mintCap()).to.be.equal(MINT_CAP);
			expect(await bridge.swapInFeePPM()).to.be.equal(SWAP_IN_FEE_PPM);
			expect(await bridge.swapOutFeePPM()).to.be.equal(SWAP_OUT_FEE_PPM);
		});
	});

	describe('swapIn / swapInTo', function () {
		const amountCoin = parseUnits('1000', 6);
		const amountStable = parseEther('1000');
		const fee = (amountStable * SWAP_IN_FEE_PPM) / 1_000_000n;

		it('mints stablecoin to the caller minus the swap-in fee', async function () {
			const curatorBalanceBefore = await stable.balanceOf(curator);

			await usdc.connect(user).approve(await bridge.getAddress(), amountCoin);
			const tx = await bridge.connect(user).swapIn(amountCoin);

			await expect(tx)
				.to.emit(bridge, 'SwapIn')
				.withArgs(user.address, amountCoin, amountStable, fee);
			await expect(tx)
				.to.emit(bridge, 'Revenue')
				.withArgs(fee, fee, amountStable);

			expect(await stable.balanceOf(user)).to.be.equal(amountStable - fee);
			expect(await stable.balanceOf(curator)).to.be.equal(curatorBalanceBefore + fee);
			expect(await usdc.balanceOf(user)).to.be.equal(parseUnits('1000000', 6) - amountCoin);

			expect(await bridge.totalMinted()).to.be.equal(amountStable);
			expect(await bridge.totalRevenue()).to.be.equal(fee);

			expect(await usdc.balanceOf(await vault.getAddress())).to.be.equal(amountCoin);
			expect(await bridge.totalAssets()).to.be.equal(amountStable);
		});

		it('returns the minted amount', async function () {
			await usdc.connect(user).approve(await bridge.getAddress(), amountCoin);
			const minted = await bridge.connect(user).swapIn.staticCall(amountCoin);
			expect(minted).to.be.equal(amountStable - fee);
		});

		it('mints to an arbitrary target via swapInTo', async function () {
			const targetBalanceBefore = await stable.balanceOf(target);

			await usdc.connect(user).approve(await bridge.getAddress(), amountCoin);
			await bridge.connect(user).swapInTo(target.address, amountCoin);

			expect(await stable.balanceOf(target)).to.be.equal(targetBalanceBefore + (amountStable - fee));
		});

		it('reverts with MintCapExceeded once mintCap headroom is exhausted', async function () {
			const TestVault4626 = await ethers.getContractFactory('TestVault4626');
			const smallVault = await TestVault4626.deploy(USDC_TOKEN);

			const smallMintCap = parseEther('100');
			const SwapBridgeMorphoV1 = await ethers.getContractFactory('SwapBridgeMorphoV1');
			const smallBridge = await SwapBridgeMorphoV1.deploy(
				addr.usduStable,
				USDC_TOKEN,
				await smallVault.getAddress(),
				smallMintCap,
				SWAP_IN_FEE_PPM,
				SWAP_OUT_FEE_PPM
			);

			const overCapAmount = parseUnits('1000', 6); // converts to 1000e18 stable, well above the 100e18 cap
			await usdc.connect(user).approve(await smallBridge.getAddress(), overCapAmount);

			await expect(smallBridge.connect(user).swapIn(overCapAmount)).to.be.revertedWithCustomError(
				smallBridge,
				'MintCapExceeded'
			);
		});
	});

	describe('swapOut / swapOutTo', function () {
		it('burns stablecoin from the caller and sends coin to the caller minus the swap-out fee', async function () {
			const amountStable = await stable.balanceOf(user);
			const fee = (amountStable * SWAP_OUT_FEE_PPM) / 1_000_000n;
			const amountCoin = ((amountStable - fee) * 10n ** 6n) / parseEther('1');

			const curatorBalanceBefore = await stable.balanceOf(curator);
			const userCoinBalanceBefore = await usdc.balanceOf(user);
			const totalMintedBefore = await bridge.totalMinted();
			const totalRevenueBefore = await bridge.totalRevenue();

			const tx = await bridge.connect(user).swapOut(amountStable);

			await expect(tx)
				.to.emit(bridge, 'SwapOut')
				.withArgs(user.address, amountStable, amountCoin, fee);

			expect(await stable.balanceOf(user)).to.be.equal(0n);
			expect(await stable.balanceOf(curator)).to.be.equal(curatorBalanceBefore + fee);
			expect(await usdc.balanceOf(user)).to.be.equal(userCoinBalanceBefore + amountCoin);

			expect(await bridge.totalMinted()).to.be.equal(totalMintedBefore - amountStable + fee);
			expect(await bridge.totalRevenue()).to.be.equal(totalRevenueBefore + fee);
		});

		it('sends coin to an arbitrary target via swapOutTo', async function () {
			// swap back in to have a fresh stablecoin balance to burn
			const amountCoin = parseUnits('500', 6);
			const amountStable = parseEther('500');
			await usdc.connect(user).approve(await bridge.getAddress(), amountCoin);
			await bridge.connect(user).swapIn(amountCoin);

			const userStableBalance = await stable.balanceOf(user);
			const fee = (userStableBalance * SWAP_OUT_FEE_PPM) / 1_000_000n;
			const expectedCoinOut = ((userStableBalance - fee) * 10n ** 6n) / parseEther('1');

			const targetCoinBalanceBefore = await usdc.balanceOf(target);
			await bridge.connect(user).swapOutTo(target.address, userStableBalance);

			expect(await stable.balanceOf(user)).to.be.equal(0n);
			expect(await usdc.balanceOf(target)).to.be.equal(targetCoinBalanceBefore + expectedCoinOut);
		});
	});

	describe('reconcile', function () {
		it('reverts with ReconcileTooSoon before the timelock has elapsed', async function () {
			// earlier swapOut/swapOutTo calls also touch lastReconciledAt as a side effect (swapOut now
			// reconciles unconditionally), so make sure it's stale before priming rather than assuming it's
			// still at its initial value
			await evm_increaseTime(timelock + 1n);

			// prime lastReconciledAt with a no-op reconcile (no yield accrued yet)
			await bridge.reconcile();

			await expect(bridge.reconcile()).to.be.revertedWithCustomError(bridge, 'ReconcileTooSoon');
		});

		it('mints accrued vault yield to the curator once the timelock has elapsed', async function () {
			// simulate yield accrual by donating coin directly into the vault
			const donation = parseUnits('50', 6);
			await usdc.connect(usdcUser).transfer(await vault.getAddress(), donation);

			const totalMintedBefore = await bridge.totalMinted();
			const totalRevenueBefore = await bridge.totalRevenue();
			const curatorBalanceBefore = await stable.balanceOf(curator);
			const assetsBefore = await bridge.totalAssets();
			const expectedMintable = assetsBefore - totalMintedBefore;

			await evm_increaseTime(timelock + 1n);
			const tx = await bridge.reconcile();

			await expect(tx)
				.to.emit(bridge, 'Revenue')
				.withArgs(expectedMintable, totalRevenueBefore + expectedMintable, totalMintedBefore + expectedMintable);

			expect(await bridge.totalMinted()).to.be.equal(totalMintedBefore + expectedMintable);
			expect(await bridge.totalRevenue()).to.be.equal(totalRevenueBefore + expectedMintable);
			expect(await stable.balanceOf(curator)).to.be.equal(curatorBalanceBefore + expectedMintable);
		});

		it('is a no-op once totalAssets no longer exceeds totalMinted', async function () {
			await evm_increaseTime(timelock + 1n);

			const totalMintedBefore = await bridge.totalMinted();
			const totalRevenueBefore = await bridge.totalRevenue();

			await bridge.reconcile();

			expect(await bridge.totalMinted()).to.be.equal(totalMintedBefore);
			expect(await bridge.totalRevenue()).to.be.equal(totalRevenueBefore);
		});
	});
});
