import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { CurveAdapterV1, Stablecoin, ICurveStableSwapNG, IERC20 } from '../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { formatUnits, parseEther, parseUnits, zeroAddress } from 'viem';
import { ADDRESS } from '../exports/address.config';
import { mainnet } from 'viem/chains';
import { evm_increaseTime } from './helper';

const addr = ADDRESS[mainnet.id];

describe('CurveAdapterV1: Liquidity Test', function () {
	let adapter: CurveAdapterV1;
	let stable: Stablecoin;
	let usdc: IERC20;
	let pool: ICurveStableSwapNG;

	let curator: SignerWithAddress;
	let module: SignerWithAddress;
	let user: SignerWithAddress;
	let usdcUser: SignerWithAddress;

	let rec0: SignerWithAddress;
	let rec1: SignerWithAddress;

	const USDC_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
	const USDC_HOLDER = '0x55fe002aeff02f77364de339a1292923a15844b8';
	const EXPIRED_AT = 999999999999n;
	const SMALL_AMOUNT = '10000';
	const LARGE_AMOUNT = '100000';

	const showDetails = async () => {
		console.log('\n=== Balances ===');
		console.table({
			User_USDC: (await usdc.balanceOf(user)).toString(),
			User_USDU: (await stable.balanceOf(user)).toString(),
			User_LP: (await pool.balanceOf(user)).toString(),
			Adapter_USDC: (await usdc.balanceOf(adapter)).toString(),
			Adapter_USDU: (await stable.balanceOf(adapter)).toString(),
			Adapter_LP: (await pool.balanceOf(adapter)).toString(),
			Adapter_Minted: (await adapter.totalMinted()).toString(),
			Adapter_Profit: (await adapter.totalRevenue()).toString(),
			Pool_Balances: (await pool.get_balances()).map((b) => b.toString()).join(', '),
		});
	};

	before(async function () {
		[module, user, rec0, rec1] = await ethers.getSigners();

		// Impersonate USDC whale and curator
		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [USDC_HOLDER] });
		usdcUser = await ethers.getSigner(USDC_HOLDER);

		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		curator = await ethers.getSigner(addr.curator);

		// Attach contracts
		stable = await ethers.getContractAt('Stablecoin', addr.usduStable);
		usdc = await ethers.getContractAt('IERC20', USDC_TOKEN);
		pool = await ethers.getContractAt('ICurveStableSwapNG', addr.curveStableSwapNG_USDUUSDC);

		// Deploy CurveAdapter
		const AdapterFactory = await ethers.getContractFactory('CurveAdapterV1');
		adapter = await AdapterFactory.deploy(addr.curveStableSwapNG_USDUUSDC, 0, 1);

		// Fund curator
		await module.sendTransaction({ to: curator.address, value: parseEther('10') });

		// Register & accept modules
		await stable.connect(curator).setModule(module, EXPIRED_AT, 'module');
		await stable.connect(curator).setModule(adapter, EXPIRED_AT, 'curve');

		await evm_increaseTime(7 * 24 * 3600 + 100); // Simulate module acceptance delay
		await stable.acceptModule(module);
		await stable.acceptModule(adapter);
	});

	// describe('Distribution Setup', () => {
	// 	it('should set and apply distribution', async () => {
	// 		await adapter
	// 			.connect(curator)
	// 			.setDistribution([rec0.address, rec1.address, zeroAddress, zeroAddress, zeroAddress], [800000n, 200000n, 0n, 0n, 0n]);
	// 	});
	// });

	describe('Balanced Setup', () => {
		it('should increase the liquidity', async () => {
			await usdc.connect(usdcUser).transfer(curator.address, parseUnits(LARGE_AMOUNT, 6));
			await usdc.connect(curator).approve(pool, parseUnits(LARGE_AMOUNT, 6));

			await stable.connect(module).mintModule(curator.address, parseUnits(LARGE_AMOUNT, 18));
			await stable.connect(curator).approve(pool, parseUnits(LARGE_AMOUNT, 18));

			await pool
				.connect(curator)
				['add_liquidity(uint256[],uint256)']([parseUnits(LARGE_AMOUNT, 18), parseUnits(LARGE_AMOUNT, 6)], 0n);

			await showDetails();
		});

		it('should roughly balance the pool', async () => {
			const balances = await pool.get_balances();
			const amountCorrected = (balances[1] * parseEther('1')) / parseUnits('1', 6);

			if (balances[0] > amountCorrected) {
				// usdc is missing
				const missing = balances[0] - amountCorrected;
				await usdc.connect(usdcUser).transfer(curator.address, formatUnits(missing, 18 - 6));
				await usdc.connect(curator).approve(pool, formatUnits(missing, 18 - 6));
				await pool.connect(curator)['add_liquidity(uint256[],uint256)']([0n, BigInt(formatUnits(missing, 18 - 6))], 0n);
			} else if (amountCorrected > balances[0]) {
				// usdu is missing
				const missing = amountCorrected - balances[0];
				await stable.connect(module).mintModule(curator.address, missing);
				await stable.connect(curator).approve(pool, missing);
				await pool.connect(curator)['add_liquidity(uint256[],uint256)']([missing, 0n], 0n);
			}

			await showDetails();
		});
	});

	describe('add liquidity operations', () => {
		it('should create an imbalance USDU > USDC', async () => {
			const amount = parseUnits(SMALL_AMOUNT, 18);
			await stable.connect(module).mintModule(curator.address, amount);
			await stable.connect(curator).approve(pool, amount);
			await pool.connect(curator)['add_liquidity(uint256[],uint256)']([amount, 0n], 0n);

			await showDetails();
		});

		it('should revert addLiquidity when not imbalanced for stable', async () => {
			await usdc.connect(usdcUser).transfer(user.address, parseUnits(SMALL_AMOUNT, 6));
			await usdc.connect(user).approve(adapter, parseUnits(SMALL_AMOUNT, 6));

			await expect(adapter.connect(user).addLiquidity(parseUnits(SMALL_AMOUNT, 6), 0)).to.be.revertedWithCustomError(
				adapter,
				'ImbalancedVariant'
			);
		});

		it('should create an imbalance USDU < USDC', async () => {
			const amount = parseUnits(SMALL_AMOUNT, 6) * 2n;
			await usdc.connect(usdcUser).transfer(curator.address, amount);
			await usdc.connect(curator).approve(pool, amount);
			await pool.connect(curator)['add_liquidity(uint256[],uint256)']([0n, amount], 0n);

			await showDetails();
		});

		it('should now correctly execute addLiquidity', async () => {
			expect(await pool.balanceOf(user)).to.be.equal(0n);

			await adapter.connect(user).addLiquidity(parseUnits(SMALL_AMOUNT, 6), 0);
			expect(await pool.balanceOf(user)).to.be.greaterThan(0n);

			await showDetails();
		});

		it('calculate IL after redeemtion of all LP shares', async () => {
			const beforeLP = await pool.balanceOf(adapter);
			const afterLP = 0n;
			const projected = await pool.calc_withdraw_one_coin(beforeLP, 0);

			const profit = await adapter.calcProfitability(beforeLP, afterLP, projected);
			expect(profit).to.be.equal(0n);

			const minted = await adapter.totalMinted();
			expect((projected * parseEther('1')) / minted).to.be.approximately(
				parseEther('1'),
				parseUnits('1', 18 - 3),
				'IL diverge higher the 10^-3, (= 1/1000)'
			);
		});

		it('should revert removeLiquidity when not imbalanced for usdc', async () => {
			const amount = ((await pool.balanceOf(user)) * 2n) / 10n;
			await pool.connect(user).approve(await adapter.getAddress(), amount);
			await expect(adapter.connect(user).removeLiquidity(amount, 0)).to.be.revertedWithCustomError(adapter, 'ImbalancedVariant');
		});
	});

	describe('remove liquidity operations', () => {
		it('should create an imbalance USDU > USDC', async () => {
			const amount = parseUnits(SMALL_AMOUNT, 18) * 4n;
			await stable.connect(module).mintModule(curator.address, amount);
			await stable.connect(curator).approve(pool, amount);
			await pool.connect(curator)['add_liquidity(uint256[],uint256)']([amount, 0n], 0n);

			await showDetails();
		});

		it('should revert due to NotProfitable', async () => {
			const lpBalance = await pool.balanceOf(user);
			const removeAmount = lpBalance;

			await pool.connect(user).approve(adapter, removeAmount);
			await expect(adapter.connect(user).removeLiquidity(removeAmount, 0)).to.be.revertedWithCustomError(adapter, 'NotProfitable');

			await showDetails();
		});

		it('Perform multiple swaps as curator', async function () {
			await usdc.connect(usdcUser).transfer(curator.address, parseUnits('10000', 6));

			for (let i = 0; i < 10; i++) {
				const usdcBal = await usdc.balanceOf(curator.address);
				await usdc.connect(curator).approve(pool, usdcBal);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](1n, 0n, usdcBal, 0n);

				const stableBal = await stable.balanceOf(curator.address);
				await stable.connect(curator).approve(pool, stableBal);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](0n, 1n, stableBal, 0n);
			}

			await showDetails();
		});

		it('should remove liquidity with a USDU > USDC imbalance and profit', async () => {
			const lpBalance = await pool.balanceOf(user);
			const removeAmount = lpBalance / 4n;

			console.log(await pool.calc_withdraw_one_coin(lpBalance, 0));

			await pool.connect(user).approve(adapter, removeAmount);
			await adapter.connect(user).removeLiquidity(removeAmount, 0);

			await showDetails();
		});

		it('should calculate correct profitability after removal', async () => {
			const initialLP = await pool.balanceOf(user);
			const removeAmount = initialLP;

			await pool.connect(user).approve(adapter, removeAmount);
			const projected = (await pool.calc_withdraw_one_coin(removeAmount * 2n, 0n)) / 2n;
			const revenue = await adapter.totalRevenue();
			const profit = await adapter.calcProfitability(initialLP, initialLP - removeAmount, projected);
			await adapter.connect(user).removeLiquidity(removeAmount, 0n);
			expect(await adapter.totalRevenue()).to.be.equal(revenue + profit);

			await showDetails();
		});

		it('should distrubute earning', async () => {
			await adapter
				.connect(curator)
				.setDistribution([rec0.address, rec1.address, zeroAddress, zeroAddress, zeroAddress], [800000n, 200000n, 0n, 0n, 0n]);

			// await adapter.connect(curator).payOffDebt();
			await adapter.connect(curator).redeem(await pool.balanceOf(await adapter.getAddress()), 0n);
			await showDetails();
		});
	});
});
