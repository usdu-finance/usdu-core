import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { IERC20Metadata, Stablecoin, SwapBridgeMorphoV1, SwapRouterV1, TestVault4626 } from '../../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ADDRESS } from '../../exports/address.config';
import { mainnet } from 'viem/chains';
import { parseEther, parseUnits } from 'viem';
import { evm_increaseTime } from '../helper';

describe('SwapRouterV1', function () {
	const addr = ADDRESS[mainnet.id];

	const USDC_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
	const USDC_HOLDER = '0x55fe002aeff02f77364de339a1292923a15844b8'; // Circle Reserve Wallet (or any whale)

	const MINT_CAP = parseEther('10000000');
	const SWAP_IN_FEE_PPM = 5_000n; // 0.5%
	const SWAP_OUT_FEE_PPM = 3_000n; // 0.3%

	let stable: Stablecoin;
	let usdc: IERC20Metadata;
	let vault: TestVault4626;
	let bridge: SwapBridgeMorphoV1;
	let router: SwapRouterV1;

	let curator: SignerWithAddress;
	let usdcUser: SignerWithAddress;
	let user: SignerWithAddress;
	let target: SignerWithAddress;
	let deployer: SignerWithAddress;
	let stranger: SignerWithAddress;

	let timelock: bigint;

	before(async function () {
		[deployer, user, target, stranger] = await ethers.getSigners();

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
		bridge = await SwapBridgeMorphoV1.deploy(addr.usduStable, await vault.getAddress(), MINT_CAP, SWAP_IN_FEE_PPM, SWAP_OUT_FEE_PPM);

		const SwapRouterV1 = await ethers.getContractFactory('SwapRouterV1');
		router = await SwapRouterV1.deploy(addr.usduStable);

		// fund curator with eth so it can send transactions
		await deployer.sendTransaction({ to: curator.address, value: parseEther('10') });

		// register bridge as a module on the stablecoin
		await stable.connect(curator).setModule(await bridge.getAddress(), await validExpiry(), 'swap-bridge-morpho-router-test');
		await evm_increaseTime(timelock + 100n);
		await stable.acceptModule(await bridge.getAddress());

		// fund the test users with USDC
		await usdc.connect(usdcUser).transfer(user, parseUnits('1000000', 6));
	});

	async function validExpiry(): Promise<bigint> {
		const latest = BigInt((await ethers.provider.getBlock('latest'))!.timestamp);
		return latest + timelock + 3650n * 24n * 60n * 60n; // ~10 years out
	}

	describe('Constructor', function () {
		it('exposes the configured stable', async function () {
			expect(await router.stable()).to.be.equal(ethers.getAddress(addr.usduStable));
		});
	});

	describe('swapIn / swapInTo', function () {
		const amountCoin = parseUnits('1000', 6);
		const amountStable = parseEther('1000');
		const fee = (amountStable * SWAP_IN_FEE_PPM) / 1_000_000n;

		it('reverts with NotAModule when module is not registered on stable', async function () {
			await usdc.connect(user).approve(await router.getAddress(), amountCoin);
			await expect(router.connect(user).swapIn(stranger.address, amountCoin)).to.be.revertedWithCustomError(
				router,
				'NotAModule'
			);
		});

		it('forwards to the module, minting stablecoin to the caller minus the swap-in fee', async function () {
			const curatorBalanceBefore = await stable.balanceOf(curator);

			await usdc.connect(user).approve(await router.getAddress(), amountCoin);
			const tx = await router.connect(user).swapIn(await bridge.getAddress(), amountCoin);

			await expect(tx)
				.to.emit(router, 'SwapIn')
				.withArgs(await bridge.getAddress(), user.address, amountCoin, amountStable - fee);
			await expect(tx).to.emit(bridge, 'SwapIn').withArgs(user.address, amountCoin, amountStable, fee);

			expect(await stable.balanceOf(user)).to.be.equal(amountStable - fee);
			expect(await stable.balanceOf(curator)).to.be.equal(curatorBalanceBefore + fee);
			expect(await usdc.balanceOf(await router.getAddress())).to.be.equal(0n);
		});

		it('returns the minted amount', async function () {
			await usdc.connect(user).approve(await router.getAddress(), amountCoin);
			const minted = await router.connect(user).swapIn.staticCall(await bridge.getAddress(), amountCoin);
			expect(minted).to.be.equal(amountStable - fee);
		});

		it('mints to an arbitrary target via swapInTo', async function () {
			const targetBalanceBefore = await stable.balanceOf(target);

			await usdc.connect(user).approve(await router.getAddress(), amountCoin);
			await router.connect(user).swapInTo(await bridge.getAddress(), target.address, amountCoin);

			expect(await stable.balanceOf(target)).to.be.equal(targetBalanceBefore + (amountStable - fee));
		});

		it('leaves no residual coin allowance for the router to redraw from a stale approval', async function () {
			// forceApprove sets the allowance to exactly `amount`, and SwapBridgeMorphoV1's swapInTo fully
			// consumes it via its own safeTransferFrom(router, module, amount) — so nothing should be left
			await usdc.connect(user).approve(await router.getAddress(), amountCoin);
			await router.connect(user).swapIn(await bridge.getAddress(), amountCoin);

			expect(await usdc.allowance(await router.getAddress(), await bridge.getAddress())).to.be.equal(0n);
		});
	});

	describe('swapOut / swapOutTo', function () {
		it('reverts with NotAModule when module is not registered on stable', async function () {
			const amountStable = parseEther('10');
			await stable.connect(user).approve(await router.getAddress(), amountStable);
			await expect(router.connect(user).swapOut(stranger.address, amountStable)).to.be.revertedWithCustomError(
				router,
				'NotAModule'
			);
		});

		it('forwards to the module, burning stablecoin from the caller and sending coin minus the swap-out fee', async function () {
			const amountStable = await stable.balanceOf(user);
			const fee = (amountStable * SWAP_OUT_FEE_PPM) / 1_000_000n;
			const amountCoin = ((amountStable - fee) * 10n ** 6n) / parseEther('1');

			const userCoinBalanceBefore = await usdc.balanceOf(user);

			await stable.connect(user).approve(await router.getAddress(), amountStable);
			const tx = await router.connect(user).swapOut(await bridge.getAddress(), amountStable);

			await expect(tx)
				.to.emit(router, 'SwapOut')
				.withArgs(await bridge.getAddress(), user.address, amountStable, amountCoin);

			expect(await stable.balanceOf(user)).to.be.equal(0n);
			expect(await usdc.balanceOf(user)).to.be.equal(userCoinBalanceBefore + amountCoin);
			expect(await stable.balanceOf(await router.getAddress())).to.be.equal(0n);
		});

		it('sends coin to an arbitrary target via swapOutTo', async function () {
			// swap back in to have a fresh stablecoin balance to burn
			const amountCoin = parseUnits('500', 6);
			const amountStable = parseEther('500');
			await usdc.connect(user).approve(await router.getAddress(), amountCoin);
			await router.connect(user).swapIn(await bridge.getAddress(), amountCoin);

			const userStableBalance = await stable.balanceOf(user);
			const fee = (userStableBalance * SWAP_OUT_FEE_PPM) / 1_000_000n;
			const expectedCoinOut = ((userStableBalance - fee) * 10n ** 6n) / parseEther('1');

			const targetCoinBalanceBefore = await usdc.balanceOf(target);
			await stable.connect(user).approve(await router.getAddress(), userStableBalance);
			await router.connect(user).swapOutTo(await bridge.getAddress(), target.address, userStableBalance);

			expect(await stable.balanceOf(user)).to.be.equal(0n);
			expect(await usdc.balanceOf(target)).to.be.equal(targetCoinBalanceBefore + expectedCoinOut);
		});

		describe('once the module has expired', function () {
			let localBridge: SwapBridgeMorphoV1;
			let localVault: TestVault4626;

			const amountCoin = parseUnits('1000', 6);

			before(async function () {
				const TestVault4626 = await ethers.getContractFactory('TestVault4626');
				localVault = await TestVault4626.deploy(USDC_TOKEN);

				const SwapBridgeMorphoV1 = await ethers.getContractFactory('SwapBridgeMorphoV1');
				localBridge = await SwapBridgeMorphoV1.deploy(
					addr.usduStable,
					await localVault.getAddress(),
					MINT_CAP,
					SWAP_IN_FEE_PPM,
					SWAP_OUT_FEE_PPM
				);

				const expiredAt = BigInt((await ethers.provider.getBlock('latest'))!.timestamp) + timelock + 300n;
				await stable.connect(curator).setModule(await localBridge.getAddress(), expiredAt, 'swap-bridge-morpho-router-wind-down');
				await evm_increaseTime(timelock + 1n);
				await stable.acceptModule(await localBridge.getAddress());

				await usdc.connect(user).approve(await localBridge.getAddress(), amountCoin);
				await localBridge.connect(user).swapIn(amountCoin);

				// cross the expiry timestamp
				await evm_increaseTime(300n);
				expect(await stable.checkValidModule(await localBridge.getAddress())).to.be.equal(false);
				// still registered (just no longer valid), so the router must keep routing to it
				expect(await stable.checkModule(await localBridge.getAddress())).to.be.equal(true);
			});

			it('swapIn through the router still reverts once the module has expired', async function () {
				await usdc.connect(user).approve(await router.getAddress(), amountCoin);
				await expect(router.connect(user).swapIn(await localBridge.getAddress(), amountCoin)).to.be.reverted;
			});

			it('swapOut through the router keeps routing to an expired-but-registered module', async function () {
				const amountStable = await stable.balanceOf(user);
				const fee = (amountStable * SWAP_OUT_FEE_PPM) / 1_000_000n;
				const amountCoinOut = ((amountStable - fee) * 10n ** 6n) / parseEther('1');

				const userCoinBalanceBefore = await usdc.balanceOf(user);

				await stable.connect(user).approve(await router.getAddress(), amountStable);
				await router.connect(user).swapOut(await localBridge.getAddress(), amountStable);

				expect(await stable.balanceOf(user)).to.be.equal(0n);
				expect(await usdc.balanceOf(user)).to.be.equal(userCoinBalanceBefore + amountCoinOut);
			});
		});
	});

	describe('execute', function () {
		it('reverts with ArrayLengthMismatch when targets/amounts/isSwapIn lengths differ', async function () {
			const bridgeAddress = await bridge.getAddress();
			await expect(
				router.connect(user).execute([bridgeAddress], [user.address, target.address], [1n], [true])
			).to.be.revertedWithCustomError(router, 'ArrayLengthMismatch');

			await expect(
				router.connect(user).execute([bridgeAddress], [user.address], [1n, 2n], [true])
			).to.be.revertedWithCustomError(router, 'ArrayLengthMismatch');

			await expect(
				router.connect(user).execute([bridgeAddress], [user.address], [1n], [true, false])
			).to.be.revertedWithCustomError(router, 'ArrayLengthMismatch');
		});

		it('batches a swapIn and a swapOut against the same module in a single call', async function () {
			const bridgeAddress = await bridge.getAddress();

			const amountCoinIn = parseUnits('200', 6);
			const amountStableIn = parseEther('200');
			const feeIn = (amountStableIn * SWAP_IN_FEE_PPM) / 1_000_000n;

			// give the user a stablecoin balance to burn in the same batch
			await usdc.connect(user).approve(bridgeAddress, parseUnits('300', 6));
			await bridge.connect(user).swapIn(parseUnits('300', 6));
			const amountStableOut = await stable.balanceOf(user);
			const feeOut = (amountStableOut * SWAP_OUT_FEE_PPM) / 1_000_000n;
			const amountCoinOut = ((amountStableOut - feeOut) * 10n ** 6n) / parseEther('1');

			await usdc.connect(user).approve(await router.getAddress(), amountCoinIn);
			await stable.connect(user).approve(await router.getAddress(), amountStableOut);

			const userCoinBalanceBefore = await usdc.balanceOf(user);
			const targetStableBalanceBefore = await stable.balanceOf(target);
			const targetCoinBalanceBefore = await usdc.balanceOf(target);

			const amountsOut = await router
				.connect(user)
				.execute.staticCall(
					[bridgeAddress, bridgeAddress],
					[target.address, target.address],
					[amountCoinIn, amountStableOut],
					[true, false]
				);
			expect(amountsOut[0]).to.be.equal(amountStableIn - feeIn);
			expect(amountsOut[1]).to.be.equal(amountCoinOut);

			await router
				.connect(user)
				.execute([bridgeAddress, bridgeAddress], [target.address, target.address], [amountCoinIn, amountStableOut], [true, false]);

			expect(await stable.balanceOf(user)).to.be.equal(0n);
			expect(await usdc.balanceOf(user)).to.be.equal(userCoinBalanceBefore - amountCoinIn);
			expect(await stable.balanceOf(target)).to.be.equal(targetStableBalanceBefore + (amountStableIn - feeIn));
			expect(await usdc.balanceOf(target)).to.be.equal(targetCoinBalanceBefore + amountCoinOut);
		});

		it('reverts the whole batch if any single swap in it fails', async function () {
			const bridgeAddress = await bridge.getAddress();
			const amountCoinIn = parseUnits('50', 6);

			await usdc.connect(user).approve(await router.getAddress(), amountCoinIn);

			await expect(
				router
					.connect(user)
					.execute([bridgeAddress, stranger.address], [target.address, target.address], [amountCoinIn, 1n], [true, true])
			).to.be.revertedWithCustomError(router, 'NotAModule');

			// the first (valid) leg must not have been applied either, since the whole batch reverted
			expect(await usdc.balanceOf(await router.getAddress())).to.be.equal(0n);
		});
	});

	describe('sweep', function () {
		it('reverts when called by a non-curator', async function () {
			await usdc.connect(usdcUser).transfer(await router.getAddress(), parseUnits('1', 6));

			await expect(
				router.connect(stranger).sweep(USDC_TOKEN, stranger.address, parseUnits('1', 6))
			).to.be.revertedWithCustomError(stable, 'NotCuratorRole');
		});

		it('recovers a stray token balance to the chosen address', async function () {
			const strandedAmount = parseUnits('2', 6);
			await usdc.connect(usdcUser).transfer(await router.getAddress(), strandedAmount);

			const routerBalance = await usdc.balanceOf(await router.getAddress());
			const targetBalanceBefore = await usdc.balanceOf(target);

			const tx = await router.connect(curator).sweep(USDC_TOKEN, target.address, routerBalance);

			await expect(tx).to.emit(router, 'Sweep').withArgs(USDC_TOKEN, target.address, routerBalance);
			expect(await usdc.balanceOf(target)).to.be.equal(targetBalanceBefore + routerBalance);
			expect(await usdc.balanceOf(await router.getAddress())).to.be.equal(0n);
		});
	});
});
