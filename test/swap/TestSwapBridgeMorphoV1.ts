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
			const feeCoin = (fee * 10n ** 6n) / parseEther('1');

			const curatorCoinBalanceBefore = await usdc.balanceOf(curator);
			const userCoinBalanceBefore = await usdc.balanceOf(user);
			const totalMintedBefore = await bridge.totalMinted();
			const totalRevenueBefore = await bridge.totalRevenue();

			const tx = await bridge.connect(user).swapOut(amountStable);

			await expect(tx)
				.to.emit(bridge, 'SwapOut')
				.withArgs(user.address, amountStable, amountCoin, fee);

			expect(await stable.balanceOf(user)).to.be.equal(0n);
			// fee is taken in coin, not minted, so the curator's stablecoin balance is untouched here
			expect(await usdc.balanceOf(curator)).to.be.equal(curatorCoinBalanceBefore + feeCoin);
			expect(await usdc.balanceOf(user)).to.be.equal(userCoinBalanceBefore + amountCoin);

			expect(await bridge.totalMinted()).to.be.equal(totalMintedBefore - amountStable);
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

		it('opportunistically mints accrued surplus to the curator as stablecoin while the module is valid', async function () {
			// fresh position so the surplus math below is easy to isolate
			const amountCoin = parseUnits('500', 6);
			const amountStable = parseEther('500');
			await usdc.connect(user).approve(await bridge.getAddress(), amountCoin);
			await bridge.connect(user).swapIn(amountCoin);

			// simulate yield accrual by donating coin directly into the vault
			const donation = parseUnits('10', 6);
			await usdc.connect(usdcUser).transfer(await vault.getAddress(), donation);

			const totalMintedBefore = await bridge.totalMinted();
			const curatorStableBalanceBefore = await stable.balanceOf(curator);
			const curatorCoinBalanceBefore = await usdc.balanceOf(curator);
			const assetsBefore = await bridge.totalAssets();
			const expectedSurplus = assetsBefore - totalMintedBefore;

			// clear the reconcile throttle so swapOut's opportunistic reconcile actually executes
			await evm_increaseTime(timelock + 1n);

			const userStableBalance = await stable.balanceOf(user);
			const swapOutFee = (userStableBalance * SWAP_OUT_FEE_PPM) / 1_000_000n;
			const swapOutFeeCoin = (swapOutFee * 10n ** 6n) / parseEther('1');

			await bridge.connect(user).swapOut(userStableBalance);

			// surplus minted as stablecoin to the curator, not redeemed as coin — the curator's coin balance
			// only moves by the (unrelated) swap-out fee, which is still taken in coin as always
			expect(await stable.balanceOf(curator)).to.be.equal(curatorStableBalanceBefore + expectedSurplus);
			expect(await usdc.balanceOf(curator)).to.be.equal(curatorCoinBalanceBefore + swapOutFeeCoin);
		});
	});

	describe('reconcile', function () {
		it('reverts when reconcile(bool) is called by a non-curator', async function () {
			await expect(bridge.connect(user)['reconcile(bool)'](true)).to.be.reverted;
		});

		it('reverts with ReconcileTooSoon before the timelock has elapsed', async function () {
			// only the permissionless reconcile() is throttled — reconcile(bool) is curator-gated and not
			// subject to stable.timelock() at all, so this specifically exercises the no-arg overload.
			// Earlier swapIn/swapOut calls also opportunistically reconcile (throttled, same as here) and may
			// have already touched lastReconciledAt, so make sure it's stale before priming rather than
			// assuming it's still at its initial value.
			await evm_increaseTime(timelock + 1n);

			// prime lastReconciledAt with a no-op reconcile (no yield accrued yet)
			await bridge['reconcile()']();

			await expect(bridge['reconcile()']()).to.be.revertedWithCustomError(bridge, 'ReconcileTooSoon');
		});

		it('reconcile(bool) is not throttled by stable.timelock(), unlike reconcile()', async function () {
			await evm_increaseTime(timelock + 1n);

			// two curator-gated calls back-to-back, no time advance in between — neither should revert
			await bridge.connect(curator)['reconcile(bool)'](true);
			await expect(bridge.connect(curator)['reconcile(bool)'](true)).to.not.be.reverted;
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
			// permissionless no-arg reconcile() also mints when the module is still valid
			const tx = await bridge['reconcile()']();

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

			await bridge.connect(curator)['reconcile(bool)'](true);

			expect(await bridge.totalMinted()).to.be.equal(totalMintedBefore);
			expect(await bridge.totalRevenue()).to.be.equal(totalRevenueBefore);
		});

		it('redeems accrued vault yield to the curator as coin when allowMinting is false', async function () {
			// simulate yield accrual by donating coin directly into the vault
			const donation = parseUnits('20', 6);
			await usdc.connect(usdcUser).transfer(await vault.getAddress(), donation);

			const totalMintedBefore = await bridge.totalMinted();
			const totalRevenueBefore = await bridge.totalRevenue();
			const curatorCoinBalanceBefore = await usdc.balanceOf(curator);
			const assetsBefore = await bridge.totalAssets();
			const expectedDeficit = assetsBefore - totalMintedBefore;
			const expectedCoin = (expectedDeficit * 10n ** 6n) / parseEther('1');

			await evm_increaseTime(timelock + 1n);
			const tx = await bridge.connect(curator)['reconcile(bool)'](false);

			await expect(tx)
				.to.emit(bridge, 'Revenue')
				.withArgs(expectedDeficit, totalRevenueBefore + expectedDeficit, totalMintedBefore);

			// totalMinted is untouched by the redeem path — only totalRevenue and the curator's coin move
			expect(await bridge.totalMinted()).to.be.equal(totalMintedBefore);
			expect(await bridge.totalRevenue()).to.be.equal(totalRevenueBefore + expectedDeficit);
			expect(await usdc.balanceOf(curator)).to.be.equal(curatorCoinBalanceBefore + expectedCoin);
		});
	});

	describe('post-expiry wind-down', function () {
		// isolated bridge + vault, expired shortly after setup, so swapOut's independence from validModule
		// (and reconcile()'s auto-fallback) can be verified directly. Generous buffers around the timelock
		// waits below avoid flaking on the exact number of implicit block-timestamp bumps in between.
		let localBridge: SwapBridgeMorphoV1;
		let localVault: TestVault4626;

		const amountCoin = parseUnits('1000', 6);

		before(async function () {
			const TestVault4626 = await ethers.getContractFactory('TestVault4626');
			localVault = await TestVault4626.deploy(USDC_TOKEN);

			const SwapBridgeMorphoV1 = await ethers.getContractFactory('SwapBridgeMorphoV1');
			localBridge = await SwapBridgeMorphoV1.deploy(
				addr.usduStable,
				USDC_TOKEN,
				await localVault.getAddress(),
				MINT_CAP,
				SWAP_IN_FEE_PPM,
				SWAP_OUT_FEE_PPM
			);

			const expiredAt = BigInt((await ethers.provider.getBlock('latest'))!.timestamp) + timelock + 300n;
			await stable.connect(curator).setModule(await localBridge.getAddress(), expiredAt, 'swap-bridge-morpho-wind-down');
			await evm_increaseTime(timelock + 1n);
			await stable.acceptModule(await localBridge.getAddress());

			await usdc.connect(user).approve(await localBridge.getAddress(), amountCoin);
			await localBridge.connect(user).swapIn(amountCoin);

			// cross the expiry timestamp
			await evm_increaseTime(300n);
			expect(await stable.checkValidModule(await localBridge.getAddress())).to.be.equal(false);
		});

		it('swapIn reverts once the module has expired', async function () {
			await usdc.connect(user).approve(await localBridge.getAddress(), amountCoin);
			await expect(localBridge.connect(user).swapIn(amountCoin)).to.be.reverted;
		});

		it('swapOut still works once the module has expired, taking its fee in coin', async function () {
			const amountStable = await stable.balanceOf(user);
			const fee = (amountStable * SWAP_OUT_FEE_PPM) / 1_000_000n;
			const amountCoinOut = ((amountStable - fee) * 10n ** 6n) / parseEther('1');
			const feeCoin = (fee * 10n ** 6n) / parseEther('1');

			const curatorCoinBalanceBefore = await usdc.balanceOf(curator);
			const userCoinBalanceBefore = await usdc.balanceOf(user);

			await localBridge.connect(user).swapOut(amountStable);

			expect(await stable.balanceOf(user)).to.be.equal(0n);
			expect(await usdc.balanceOf(user)).to.be.equal(userCoinBalanceBefore + amountCoinOut);
			expect(await usdc.balanceOf(curator)).to.be.equal(curatorCoinBalanceBefore + feeCoin);
		});

		it('permissionless reconcile() auto-falls-back to redeeming instead of reverting once expired', async function () {
			// simulate yield accrual by donating coin directly into the vault; doesn't need validModule
			const donation = parseUnits('5', 6);
			await usdc.connect(usdcUser).transfer(await localVault.getAddress(), donation);

			const totalMintedBefore = await localBridge.totalMinted();
			const totalRevenueBefore = await localBridge.totalRevenue();
			const curatorCoinBalanceBefore = await usdc.balanceOf(curator);
			const assetsBefore = await localBridge.totalAssets();
			const expectedDeficit = assetsBefore - totalMintedBefore;
			const expectedCoin = (expectedDeficit * 10n ** 6n) / parseEther('1');

			await evm_increaseTime(timelock + 1n);
			// called by an arbitrary, non-curator signer — reconcile() stays permissionless even post-expiry
			const tx = await localBridge.connect(user)['reconcile()']();

			await expect(tx)
				.to.emit(localBridge, 'Revenue')
				.withArgs(expectedDeficit, totalRevenueBefore + expectedDeficit, totalMintedBefore);

			// redeemed, not minted: totalMinted is untouched, curator receives coin
			expect(await localBridge.totalMinted()).to.be.equal(totalMintedBefore);
			expect(await localBridge.totalRevenue()).to.be.equal(totalRevenueBefore + expectedDeficit);
			expect(await usdc.balanceOf(curator)).to.be.equal(curatorCoinBalanceBefore + expectedCoin);
		});
	});

	describe('post-expiry swapOut with accrued surplus', function () {
		// dedicated bridge + vault: needs its own user balance deposited before expiry (swapIn no longer
		// works once expired), so it can't share state with the 'post-expiry wind-down' block above
		let localBridge: SwapBridgeMorphoV1;
		let localVault: TestVault4626;

		const amountCoin = parseUnits('1000', 6);

		before(async function () {
			const TestVault4626 = await ethers.getContractFactory('TestVault4626');
			localVault = await TestVault4626.deploy(USDC_TOKEN);

			const SwapBridgeMorphoV1 = await ethers.getContractFactory('SwapBridgeMorphoV1');
			localBridge = await SwapBridgeMorphoV1.deploy(
				addr.usduStable,
				USDC_TOKEN,
				await localVault.getAddress(),
				MINT_CAP,
				SWAP_IN_FEE_PPM,
				SWAP_OUT_FEE_PPM
			);

			const expiredAt = BigInt((await ethers.provider.getBlock('latest'))!.timestamp) + timelock + 300n;
			await stable.connect(curator).setModule(await localBridge.getAddress(), expiredAt, 'swap-bridge-morpho-surplus');
			await evm_increaseTime(timelock + 1n);
			await stable.acceptModule(await localBridge.getAddress());

			await usdc.connect(user).approve(await localBridge.getAddress(), amountCoin);
			await localBridge.connect(user).swapIn(amountCoin);

			// cross the expiry timestamp
			await evm_increaseTime(300n);
			expect(await stable.checkValidModule(await localBridge.getAddress())).to.be.equal(false);
		});

		it("swapOut's own reconcile call auto-falls-back to redeeming the surplus as coin, not minting", async function () {
			// simulate yield accrual by donating coin directly into the vault; doesn't need validModule
			const donation = parseUnits('5', 6);
			await usdc.connect(usdcUser).transfer(await localVault.getAddress(), donation);

			const totalMintedBefore = await localBridge.totalMinted();
			const curatorStableBalanceBefore = await stable.balanceOf(curator);
			const curatorCoinBalanceBefore = await usdc.balanceOf(curator);
			const assetsBefore = await localBridge.totalAssets();
			const expectedSurplus = assetsBefore - totalMintedBefore;
			const expectedSurplusCoin = (expectedSurplus * 10n ** 6n) / parseEther('1');

			// clear the reconcile throttle so swapOut's opportunistic reconcile actually executes
			await evm_increaseTime(timelock + 1n);

			const userStableBalance = await stable.balanceOf(user);
			const swapOutFee = (userStableBalance * SWAP_OUT_FEE_PPM) / 1_000_000n;
			const swapOutFeeCoin = (swapOutFee * 10n ** 6n) / parseEther('1');
			const userCoinBalanceBefore = await usdc.balanceOf(user);
			const amountCoinOut = ((userStableBalance - swapOutFee) * 10n ** 6n) / parseEther('1');

			// doesn't revert despite the module being expired — the auto-fallback inside _reconcile kicks in
			await localBridge.connect(user).swapOut(userStableBalance);

			// surplus redeemed as coin (curator's stablecoin balance untouched by it), swap itself unaffected
			expect(await stable.balanceOf(curator)).to.be.equal(curatorStableBalanceBefore);
			expect(await usdc.balanceOf(curator)).to.be.equal(curatorCoinBalanceBefore + expectedSurplusCoin + swapOutFeeCoin);
			expect(await usdc.balanceOf(user)).to.be.equal(userCoinBalanceBefore + amountCoinOut);
			expect(await stable.balanceOf(user)).to.be.equal(0n);
		});
	});
});
