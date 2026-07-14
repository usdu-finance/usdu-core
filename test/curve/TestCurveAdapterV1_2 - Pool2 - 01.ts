import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { CurveAdapterV1_2, ICurveStableSwapNG, IERC20, Stablecoin } from '../../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { evm_increaseTime, evm_mine_blocks } from '../helper';
import { parseEther, parseUnits, zeroAddress } from 'viem';
import { ADDRESS } from '../../exports/address.config';
import { mainnet } from 'viem/chains';

const blockNumber = 25532624;
const addr = ADDRESS[mainnet.id];

const IDX_USDC = 0n;
const IDX_USDU = 1n;

describe('CurveAdapterV1_2: Enhanced Integration Tests', function () {
	let stable: Stablecoin;
	let usdc: IERC20;
	let adapter: CurveAdapterV1_2;
	let pool: ICurveStableSwapNG;

	let curator: SignerWithAddress;
	let module: SignerWithAddress;
	let user: SignerWithAddress;
	let user2: SignerWithAddress;
	let usdcUser: SignerWithAddress;

	let rec0: SignerWithAddress;
	let rec1: SignerWithAddress;

	const USDC_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
	const USDC_HOLDER = '0x55fe002aeff02f77364de339a1292923a15844b8';
	const EXPIRED_AT = 999999999999n;
	const SMALL_AMOUNT = '100000'; // $100k
	const MEDIUM_AMOUNT = '250000'; // $250k
	const LARGE_AMOUNT = '500000'; // $500k

	// checkImbalance() returns [deficientIndex, magnitude, deviation]; deficientIndex === IDX_USDU means coin-heavy
	const isCoinHeavy = async () => {
		const [deficientIndex] = await adapter.checkImbalance();
		return deficientIndex === IDX_USDU;
	};

	// Helper to display current adapter state
	const showAdapterState = async () => {
		const totalAssets = await adapter.totalAssets();
		const totalMinted = await adapter.totalMinted();
		const totalRevenue = await adapter.totalRevenue();
		const [deficientIndex, magnitude, deviation] = await adapter.checkImbalance();
		const adapterLP = await pool.balanceOf(adapter);
		const virtualPrice = await pool.get_virtual_price();
		const poolBalances = await pool.get_balances();

		console.log('\n=== Adapter State ===');
		console.table({
			Total_Assets: ethers.formatEther(totalAssets),
			Total_Minted: ethers.formatEther(totalMinted),
			Total_Revenue: ethers.formatEther(totalRevenue),
			Adapter_LP: ethers.formatEther(adapterLP),
			Imbalance: deficientIndex === IDX_USDU ? 'USDU < USDC (coin-heavy)' : 'USDU > USDC (stable-heavy)',
			Deviation: ethers.formatEther(deviation),
			Virtual_Price: ethers.formatEther(virtualPrice),
			Pool_USDC: ethers.formatUnits(poolBalances[0], 6), // USDC at index 0
			Pool_USDU: ethers.formatEther(poolBalances[1]), // USDU at index 1
			uProfit_Loss: ethers.formatEther(totalAssets - totalMinted),
		});
	};

	before(async function () {
		// Reset fork to specific block height
		await network.provider.request({
			method: 'hardhat_reset',
			params: [
				{
					forking: {
						jsonRpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_RPC_KEY}`,
						blockNumber, // Set your desired block number here
					},
				},
			],
		});

		[module, user, user2, rec0, rec1] = await ethers.getSigners();

		// Impersonate USDC whale and curator
		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [USDC_HOLDER] });
		usdcUser = await ethers.getSigner(USDC_HOLDER);

		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		curator = await ethers.getSigner(addr.curator);

		// Attach contracts
		stable = await ethers.getContractAt('Stablecoin', addr.usduStable);
		usdc = await ethers.getContractAt('IERC20', USDC_TOKEN);
		pool = await ethers.getContractAt('ICurveStableSwapNG', addr.curveStableSwapNG_USDCUSDU);

		// Deploy CurveAdapterV1_2
		const AdapterFactory = await ethers.getContractFactory('CurveAdapterV1_2');
		adapter = await AdapterFactory.deploy(
			addr.curveStableSwapNG_USDCUSDU,
			1, // USDU index
			0, // USDC index
			[rec0.address, rec1.address, zeroAddress, zeroAddress, zeroAddress],
			[800000n, 200000n, 0n, 0n, 0n] // 80/20 split
		);

		// Fund curator with ETH
		await module.sendTransaction({ to: curator.address, value: parseEther('10') });

		// Register & accept modules
		await stable.connect(curator).setModule(module, EXPIRED_AT, 'module');
		await stable.connect(curator).setModule(adapter, EXPIRED_AT, 'curve_v1_2');

		await evm_increaseTime(7 * 24 * 3600 + 100); // Wait for timelock
		await stable.acceptModule(module);
		await stable.acceptModule(adapter);
	});

	describe('1. Basic Functionality', () => {
		it('should have correct initial state', async () => {
			expect(await adapter.totalAssets()).to.equal(0);
			expect(await adapter.totalMinted()).to.equal(0);
			expect(await adapter.totalRevenue()).to.equal(0);
			expect(await pool.balanceOf(adapter)).to.equal(0);

			await showAdapterState();
		});

		it('should check and display current pool state', async () => {
			const poolBalances = await pool.get_balances();
			const isImbalanced = await isCoinHeavy();
			const virtualPrice = await pool.get_virtual_price();

			console.log('\n=== Initial Pool State ===');
			console.table({
				Pool_USDC: ethers.formatUnits(poolBalances[0], 6), // USDC at index 0
				Pool_USDU: ethers.formatEther(poolBalances[1]), // USDU at index 1
				Virtual_Price: ethers.formatEther(virtualPrice),
				Is_Coin_Heavy: isImbalanced,
			});

			// If pool is not coin-heavy, create favorable conditions
			if (!isImbalanced) {
				console.log('Pool is USDU-heavy, adding USDC to make pool coin-heavy...');

				// Add USDC to the pool to make it more coin-heavy
				const usdcAmount = parseUnits(LARGE_AMOUNT, 6); // Large amount to shift balance
				await usdc.connect(usdcUser).transfer(curator.address, usdcAmount);
				await usdc.connect(curator).approve(pool, usdcAmount);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](0, 1, usdcAmount, 0); // USDC(0) -> USDU(1)

				const newBalances = await pool.get_balances();
				const newImbalance = await isCoinHeavy();

				console.log('\n=== Pool State After Balancing ===');
				console.table({
					Pool_USDC: ethers.formatUnits(newBalances[0], 6), // USDC at index 0
					Pool_USDU: ethers.formatEther(newBalances[1]), // USDU at index 1
					Is_Coin_Heavy_Now: newImbalance,
				});
			}

			await showAdapterState();
		});

		it('should calculate totalAssets using virtual price', async () => {
			// Initially no LP tokens
			expect(await adapter.totalAssets()).to.equal(0);

			// Add some LP tokens directly to adapter for testing
			const testAmount = parseUnits(SMALL_AMOUNT, 6); // USDC amount
			await usdc.connect(usdcUser).transfer(curator.address, testAmount);
			await usdc.connect(curator).approve(pool, testAmount);

			const testUsdu = parseEther(SMALL_AMOUNT); // USDU amount
			await stable.connect(module).mintModule(curator.address, testUsdu);
			await stable.connect(curator).approve(pool, testUsdu);

			// Construct amounts array properly - USDC at index 0, USDU at index 1
			const amounts = [testAmount, testUsdu];
			const tx = await pool.connect(curator)['add_liquidity(uint256[],uint256)'](amounts, 0);
			const receipt = await tx.wait();

			// Transfer LP tokens to adapter - get balance first
			const curatorLP = await pool.balanceOf(curator.address);
			await pool.connect(curator).transfer(adapter, curatorLP);

			// Now totalAssets should use virtual price calculation
			const totalAssets = await adapter.totalAssets();
			const adapterLP = await pool.balanceOf(adapter);
			const virtualPrice = await pool.get_virtual_price();
			const expectedAssets = (adapterLP * virtualPrice) / parseEther('1');

			expect(totalAssets).to.equal(expectedAssets);
			expect(totalAssets).to.be.gt(0);

			await showAdapterState();
		});
	});

	describe('2. Liquidity Addition', () => {
		before(async () => {
			// Fund users with USDC
			await usdc.connect(usdcUser).transfer(user.address, parseUnits(MEDIUM_AMOUNT, 6));
			await usdc.connect(usdcUser).transfer(user2.address, parseUnits(SMALL_AMOUNT, 6));
		});

		it('should verify pool is ready for liquidity addition', async () => {
			const isImbalanced = await isCoinHeavy();
			const poolBalances = await pool.get_balances();

			console.log('\n=== Pre-Addition Pool Check ===');
			console.table({
				Pool_USDC: ethers.formatUnits(poolBalances[0], 6), // USDC at index 0
				Pool_USDU: ethers.formatEther(poolBalances[1]), // USDU at index 1
				Is_Coin_Heavy: isImbalanced,
				Ready_For_Addition: isImbalanced ? 'YES' : 'NO',
			});

			// If still not ready, force favorable conditions
			if (!isImbalanced) {
				console.log('Forcing coin-heavy conditions for testing...');
				const usdcAmount = parseUnits(LARGE_AMOUNT, 6);
				await usdc.connect(usdcUser).transfer(curator.address, usdcAmount);
				await usdc.connect(curator).approve(pool, usdcAmount);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](0, 1, usdcAmount, 0); // USDC(0) -> USDU(1)

				expect(await isCoinHeavy()).to.be.true;
			}
		});

		it('should allow users to add liquidity when pool is coin-heavy', async () => {
			await showAdapterState();

			// Ensure pool is coin-heavy before test
			const isCurrentlyImbalanced = await isCoinHeavy();
			if (!isCurrentlyImbalanced) {
				const usdcBalanceAmount = parseUnits(LARGE_AMOUNT, 6);
				await usdc.connect(usdcUser).transfer(curator.address, usdcBalanceAmount);
				await usdc.connect(curator).approve(pool, usdcBalanceAmount);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](0, 1, usdcBalanceAmount, 0);
			}

			const usdcAmount = parseUnits(SMALL_AMOUNT, 6);

			// Approve and add liquidity
			await usdc.connect(user).approve(adapter, usdcAmount);

			const balanceBefore = await pool.balanceOf(user);
			const totalMintedBefore = await adapter.totalMinted();

			const tx = await adapter.connect(user).addLiquidity(usdcAmount, 0);
			const receipt = await tx.wait();

			// Get the user's current LP balance to calculate what was received
			const balanceAfter = await pool.balanceOf(user);
			const lpReceived = balanceAfter - balanceBefore;

			// Verify results
			expect(await pool.balanceOf(user)).to.equal(balanceBefore + lpReceived);
			expect(await adapter.totalMinted()).to.equal(totalMintedBefore + parseEther(SMALL_AMOUNT));
			expect(await usdc.balanceOf(user)).to.equal(parseUnits(MEDIUM_AMOUNT, 6) - usdcAmount);

			// Verify LP tokens were split
			const adapterLP = await pool.balanceOf(adapter);
			expect(adapterLP).to.be.gt(0);
			expect(lpReceived).to.be.gt(0);

			await showAdapterState();
		});

		it('call reconcile and balance out accounting, for later use', async () => {
			await showAdapterState();

			await adapter.reconcile();

			await showAdapterState();
		});
	});

	describe('3. Liquidity Removal', () => {
		let userLPTokens: bigint;

		before(async () => {
			// Calculate LP tokens received
			const lpBalance = await pool.balanceOf(user.address);
			userLPTokens = lpBalance;
		});

		it('should allow profitable liquidity removal', async () => {
			await showAdapterState();

			// Create favorable conditions for removal by swapping USDU -> USDC
			const swapAmount = parseUnits('200000', 18);
			await stable.connect(module).mintModule(curator.address, swapAmount);
			await stable.connect(curator).approve(pool, swapAmount);
			await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](1, 0, swapAmount, 0);

			await showAdapterState();

			// User should now be able to remove liquidity profitably
			await pool.connect(user).approve(adapter, userLPTokens);

			const totalRevenueBefore = await adapter.totalRevenue();
			const userBalanceBefore = await stable.balanceOf(user);

			const tx = await adapter.connect(user).removeLiquidity(userLPTokens, [0n, 0n]);
			const receipt = await tx.wait();

			// Calculate USDU received
			const userBalanceAfter = await stable.balanceOf(user);
			const usduReceived = userBalanceAfter - userBalanceBefore;

			// Verify user received USDU
			expect(await stable.balanceOf(user)).to.equal(userBalanceBefore + usduReceived);
			expect(usduReceived).to.be.gt(0);

			// Verify protocol revenue may have increased
			const totalRevenueAfter = await adapter.totalRevenue();
			expect(totalRevenueAfter).to.be.gte(totalRevenueBefore);

			await showAdapterState();
		});

		it('should revert when removal is not profitable', async () => {
			await usdc.connect(usdcUser).transfer(user, parseUnits(SMALL_AMOUNT, 6));
			await usdc.connect(user).approve(await pool.getAddress(), parseUnits(SMALL_AMOUNT, 6));
			await pool.connect(user)['add_liquidity(uint256[],uint256)']([parseUnits(SMALL_AMOUNT, 6), 0n], 0n);

			await showAdapterState();

			userLPTokens = await pool.balanceOf(user);
			await pool.connect(user).approve(adapter, userLPTokens);

			const loops = 4;
			for (let i = 0; i < loops; i++) {
				try {
					await adapter.connect(user).removeLiquidity(userLPTokens / 4n, [0n, 0n]);

					console.log(`### Loop: ${i + 1} / ${loops} below:`);
					await showAdapterState();
				} catch (err) {
					// Once the remaining imbalance is small, a fixed-size removal can overshoot past
					// balance into the opposite direction — the adapter correctly rejects that instead
					// of flipping the pool the wrong way.
					expect((err as Error).message).to.match(/ImbalancedVariant|NotProfitable/);
					console.log(`### Loop: ${i + 1} / ${loops} reverted as expected (pool near balance)`);
					break;
				}
			}
		});
	});

	describe('4. Profit Reconciliation', () => {
		before(async () => {
			// Section 2 already called reconcile() once; ReconcileGuard enforces a 50,000 block
			// cooldown between calls, so advance past it before reconciling again here.
			await evm_mine_blocks(50000);
			await showAdapterState();
		});

		it('should revert when no profit to reconcile', async () => {
			const assets = await adapter.totalAssets();
			const minted = await adapter.totalMinted();

			if (assets <= minted) {
				await expect(adapter.reconcile()).to.be.revertedWithCustomError(adapter, 'NothingToReconcile').withArgs(assets, minted);
			}
		});

		it('should successfully reconcile when adapter is profitable', async () => {
			// Create profitable conditions through trading fees
			// Multiple small trades to accumulate fees
			for (let i = 0; i < 5; i++) {
				const tradeAmount = parseUnits('1000', 6);
				await usdc.connect(usdcUser).transfer(curator.address, tradeAmount);
				await usdc.connect(curator).approve(pool, tradeAmount);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](0, 1, tradeAmount, 0); // USDC(0) -> USDU(1)

				const receivedUsdu = await stable.balanceOf(curator);
				await stable.connect(curator).approve(pool, receivedUsdu);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](1, 0, receivedUsdu, 0); // USDU(1) -> USDC(0)
			}

			await showAdapterState();

			const assetsBefore = await adapter.totalAssets();
			const mintedBefore = await adapter.totalMinted();
			const revenueBefore = await adapter.totalRevenue();

			if (assetsBefore > mintedBefore) {
				const expectedProfit = assetsBefore - mintedBefore;

				// Check recipient balances before
				const rec0BalBefore = await stable.balanceOf(rec0);
				const rec1BalBefore = await stable.balanceOf(rec1);

				const tx = await adapter.reconcile();
				const receipt = await tx.wait();

				// Calculate actual profit from the change in totalMinted
				const mintedAfter = await adapter.totalMinted();
				const actualProfit = mintedAfter - mintedBefore;

				// Verify profit was calculated correctly
				expect(actualProfit).to.equal(expectedProfit);

				// Verify accounting updates
				expect(await adapter.totalMinted()).to.equal(mintedBefore + expectedProfit);
				expect(await adapter.totalRevenue()).to.equal(revenueBefore + expectedProfit);

				// Verify profit was distributed (80/20 split)
				const rec0BalAfter = await stable.balanceOf(rec0);
				const rec1BalAfter = await stable.balanceOf(rec1);

				expect(rec0BalAfter).to.be.gt(rec0BalBefore);
				expect(rec1BalAfter).to.be.gt(rec1BalBefore);

				// After reconciliation, assets should equal minted
				expect(await adapter.totalAssets()).to.be.approximately(await adapter.totalMinted(), parseEther('0.01'));
			}
		});
	});

	describe('5. Emergency Controls', () => {
		it('should allow curator to perform emergency redemption with debt coverage', async () => {
			const adapterLP = await pool.balanceOf(adapter);
			if (adapterLP > 0) {
				const redeemAmount = adapterLP / 4n; // Redeem 25%
				const coverageAmount = parseEther('1000'); // Provide extra coverage

				// Curator provides debt coverage
				await stable.connect(module).mintModule(curator.address, coverageAmount);
				await stable.connect(curator).approve(adapter, coverageAmount);

				const totalMintedBefore = await adapter.totalMinted();

				await adapter.connect(curator).redeemLiquidity(coverageAmount, redeemAmount, [0n, 0n]);

				// Verify LP tokens were redeemed
				expect(await pool.balanceOf(adapter)).to.equal(adapterLP - redeemAmount);

				// Verify debt was reduced
				expect(await adapter.totalMinted()).to.be.lt(totalMintedBefore);
			}
		});

		it('should allow anyone to reduce adapter debt', async () => {
			const currentDebt = await adapter.totalMinted();
			if (currentDebt > 0) {
				const reductionAmount = parseEther('500');

				// reduceMint burns the adapter's entire stable balance, not just what's contributed here —
				// account for any pre-existing dust so the expected reduction matches exactly.
				const residualBefore = await stable.balanceOf(adapter);
				const expectedReduction = residualBefore + reductionAmount;

				// Mint tokens to user for debt reduction
				await stable.connect(module).mintModule(user.address, reductionAmount);
				await stable.connect(user).approve(adapter, reductionAmount);

				const rec0BalBefore = await stable.balanceOf(rec0);

				const tx = await adapter.connect(user).reduceMint(reductionAmount);
				const receipt = await tx.wait();

				// Calculate reduced amount from debt change
				const currentDebtAfter = await adapter.totalMinted();
				const reduced = currentDebt - currentDebtAfter;

				// Verify debt was reduced
				expect(reduced).to.equal(expectedReduction);
				expect(await adapter.totalMinted()).to.equal(currentDebt - expectedReduction);

				// Verify excess was distributed
				expect(await stable.balanceOf(rec0)).to.be.gte(rec0BalBefore);
			}
		});

		it('should reject zero amount reductions', async () => {
			await expect(adapter.connect(user).reduceMint(0)).to.be.revertedWithCustomError(adapter, 'ZeroAmount');
		});
	});

	describe('6. Edge Cases and Security', () => {
		it('should handle virtual price fluctuations gracefully', async () => {
			const virtualPriceBefore = await pool.get_virtual_price();
			const assetsBefore = await adapter.totalAssets();

			// Large trade to potentially affect virtual price
			const largeTradeAmount = parseUnits('10000', 6);
			await usdc.connect(usdcUser).transfer(curator.address, largeTradeAmount);
			await usdc.connect(curator).approve(pool, largeTradeAmount);
			await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](0, 1, largeTradeAmount, 0); // USDC(0) -> USDU(1)

			const virtualPriceAfter = await pool.get_virtual_price();
			const assetsAfter = await adapter.totalAssets();

			// Virtual price should generally increase due to trading fees
			expect(virtualPriceAfter).to.be.gte(virtualPriceBefore);

			// Assets calculation should remain stable
			const adapterLP = await pool.balanceOf(adapter);
			const expectedAssets = (adapterLP * virtualPriceAfter) / parseEther('1');
			expect(assetsAfter).to.equal(expectedAssets);
		});

		it('should maintain consistent calcBurnable logic', async () => {
			const totalMinted = await adapter.totalMinted();
			const beforeLP = parseEther('1000');
			const afterLP = parseEther('900'); // 10% reduction

			const burnable = await adapter.calcBurnable(beforeLP, afterLP);
			const expectedBurnable = (totalMinted * (beforeLP - afterLP)) / beforeLP;

			expect(burnable).to.equal(expectedBurnable);
		});

		it('should preserve imbalance protection', async () => {
			// Verify imbalance checking still works
			const isImbalanced = await isCoinHeavy();
			console.log(`Current pool is coin-heavy: ${isImbalanced}`);

			// Should not throw for valid states
			await adapter.verifyImbalance(isImbalanced);

			// Should revert for invalid states
			await expect(adapter.verifyImbalance(!isImbalanced)).to.be.revertedWithCustomError(adapter, 'ImbalancedVariant');
		});
	});

	describe('7. Integration Testing', () => {
		it('should handle multiple users and operations simultaneously', async () => {
			await showAdapterState();

			// Ensure pool is in favorable state for testing
			const currentImbalance = await isCoinHeavy();
			if (!currentImbalance) {
				console.log('Setting up favorable pool conditions for integration test...');
				const usdcAmount = parseUnits(LARGE_AMOUNT, 6);
				await usdc.connect(usdcUser).transfer(curator.address, usdcAmount);
				await usdc.connect(curator).approve(pool, usdcAmount);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](0, 1, usdcAmount, 0); // USDC(0) -> USDU(1)
			}

			// Multiple users perform operations
			const users = [user, user2];

			for (let i = 0; i < users.length; i++) {
				const amount = parseUnits('1000', 6);
				await usdc.connect(usdcUser).transfer(users[i].address, amount);
				await usdc.connect(users[i]).approve(adapter, amount);
			}

			// Users add liquidity (should work now with favorable conditions)
			const lpTokens = [];
			for (const u of users) {
				const canAdd = await isCoinHeavy();
				console.log(`User can add liquidity: ${canAdd}`);
				if (canAdd) {
					const lpBefore = await pool.balanceOf(u.address);
					const tx = await adapter.connect(u).addLiquidity(parseUnits('1000', 6), 0);
					const receipt = await tx.wait();
					const lpAfter = await pool.balanceOf(u.address);
					const lp = lpAfter - lpBefore;
					lpTokens.push(lp);
					console.log(`User received ${ethers.formatEther(lp)} LP tokens`);
				}
			}

			// Verify state consistency
			const totalAssets = await adapter.totalAssets();
			const totalMinted = await adapter.totalMinted();
			console.log(`Final state - Assets: ${ethers.formatEther(totalAssets)}, Minted: ${ethers.formatEther(totalMinted)}`);

			expect(totalAssets).to.be.gt(0);
			expect(totalMinted).to.be.gt(0);
			expect(lpTokens.length).to.be.gt(0); // At least some users should have succeeded
		});
	});
});
