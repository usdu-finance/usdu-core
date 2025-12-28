import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { CurveAdapterV1, ICurveStableSwapNG, IERC20, Stablecoin } from '../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { evm_increaseTime } from './helper';
import { parseEther, parseUnits, zeroAddress } from 'viem';
import { ADDRESS } from '../exports/address.config';
import { mainnet } from 'viem/chains';

const addr = ADDRESS[mainnet.id];

describe('CurveAdapterV1: Stablecoin Integration Tests', function () {
	let stable: Stablecoin;
	let usdc: IERC20;
	let adapter: CurveAdapterV1;
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
	const LARGE_AMOUNT = '50000';

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

	describe('Distribution Setup', () => {
		it('should set and apply distribution', async () => {
			await adapter
				.connect(curator)
				.setDistribution([rec0, rec1, zeroAddress, zeroAddress, zeroAddress], [800000n, 200000n, 0n, 0n, 0n]);
		});
	});

	describe('Pool Imbalance Tests', function () {
		it('User adds USDC liquidity via adapter', async function () {
			await usdc.connect(usdcUser).transfer(user.address, parseUnits(SMALL_AMOUNT, 6));
			await usdc.connect(user).approve(adapter, parseUnits(SMALL_AMOUNT, 6));

			expect(await pool.balanceOf(user.address)).to.equal(0);
			await adapter.connect(user).addLiquidity(parseUnits(SMALL_AMOUNT, 6), 0n);
			expect(await usdc.balanceOf(user.address)).to.equal(0);
			expect(await pool.balanceOf(user.address)).to.be.gt(0);
		});

		it('Create imbalance by swapping USDU to USDC', async function () {
			const mintAmount = parseUnits('5000', 18);
			await stable.connect(module).mintModule(curator.address, mintAmount);

			await stable.connect(curator).approve(pool, mintAmount);
			await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](0n, 1n, mintAmount, 0n);
		});

		it('Add large liquidity to support pool', async function () {
			const stableAmount = parseUnits(LARGE_AMOUNT, 18);
			const usdcAmount = parseUnits(LARGE_AMOUNT, 6);

			await stable.connect(module).mintModule(curator.address, stableAmount);
			await usdc.connect(usdcUser).transfer(curator.address, usdcAmount);

			await stable.connect(curator).approve(pool, stableAmount);
			await usdc.connect(curator).approve(pool, usdcAmount);

			await pool.connect(curator)['add_liquidity(uint256[],uint256)']([stableAmount, usdcAmount], 0);
		});

		it('User remove liquidity fails due to NotProfitable', async function () {
			const lpToRemove = ((await pool.balanceOf(user.address)) * 2n) / 8n;
			await pool.connect(user).approve(adapter, lpToRemove);

			await expect(adapter.connect(user).removeLiquidity(lpToRemove, 0n)).to.be.revertedWithCustomError(adapter, 'NotProfitable');
		});

		it('Perform multiple swaps as curator', async function () {
			await usdc.connect(usdcUser).transfer(curator.address, parseUnits('100', 6));

			for (let i = 0; i < 10; i++) {
				const usdcBal = await usdc.balanceOf(curator.address);
				await usdc.connect(curator).approve(pool, usdcBal);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](1n, 0n, usdcBal, 0n);

				const stableBal = await stable.balanceOf(curator.address);
				await stable.connect(curator).approve(pool, stableBal);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](0n, 1n, stableBal, 0n);
			}
		});

		it('Adding liquidity reverts due to ImbalancedVariant', async function () {
			const amt = parseUnits(SMALL_AMOUNT, 6);
			await usdc.connect(usdcUser).transfer(user.address, amt);
			await usdc.connect(user).approve(adapter, amt);

			await expect(adapter.connect(user).addLiquidity(amt, 0n)).to.be.revertedWithCustomError(adapter, 'ImbalancedVariant');
		});

		it('User redeems partial LP successfully', async function () {
			const userLP = await pool.balanceOf(user.address);
			const redeemAmount = (userLP * 2n) / 8n;

			const beforeLP = await pool.balanceOf(adapter);
			const afterLP = beforeLP - redeemAmount;
			const projected = await pool.calc_withdraw_one_coin(redeemAmount * 2n, 0);
			const split = projected / 2n;
			const profit = await adapter.calcProfitability(beforeLP, afterLP, split);
			const revenueBefore = await adapter.totalRevenue();

			expect(userLP).to.be.gt(0);
			await pool.connect(user).approve(adapter, redeemAmount);
			await adapter.connect(user).removeLiquidity(redeemAmount, 0n);
			expect(await adapter.totalRevenue()).to.be.equal(revenueBefore + profit);
		});

		it('Curator redeems remaining LP in adapter', async function () {
			await showDetails();
			const remainingLP = await pool.balanceOf(adapter);
			await adapter.connect(curator).redeem(remainingLP, 0n);

			await showDetails();
			expect(await usdc.balanceOf(adapter)).to.equal(0);
			expect(await stable.balanceOf(adapter)).to.be.equal(0);
		});
	});
});
