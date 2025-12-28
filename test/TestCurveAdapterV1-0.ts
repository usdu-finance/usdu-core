import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { CurveAdapterV1, ICurveStableSwapNG, IERC20, Stablecoin } from '../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { evm_increaseTime, getTimeStamp } from './helper';
import { parseEther, parseUnits } from 'viem';
import { ADDRESS } from '../exports/address.config';
import { mainnet } from 'viem/chains';

const addr = ADDRESS[mainnet.id];

describe('Deploy Stablecoin', function () {
	let stable: Stablecoin;
	let usdc: IERC20;
	let adapter: CurveAdapterV1;
	let pool: ICurveStableSwapNG;
	let curator: SignerWithAddress;
	let module: SignerWithAddress;
	let user: SignerWithAddress;
	let usdcUser: SignerWithAddress;

	const USDC_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
	const USDC_HOLDER = '0x55fe002aeff02f77364de339a1292923a15844b8'; // Circle Reserve Wallet (or any whale)
	const expiredAt = 999999999999;
	const amount = '10000';

	before(async function () {
		[module, user] = await ethers.getSigners();

		// hardhat_impersonateAccount usdc holder
		await network.provider.request({
			method: 'hardhat_impersonateAccount',
			params: [USDC_HOLDER],
		});
		usdcUser = await ethers.getSigner(USDC_HOLDER);

		// hardhat_impersonateAccount curator
		await network.provider.request({
			method: 'hardhat_impersonateAccount',
			params: [addr.curator],
		});
		curator = await ethers.getSigner(addr.curator);

		// parse contracts
		stable = await ethers.getContractAt('Stablecoin', addr.usduStable);
		usdc = await ethers.getContractAt('IERC20', USDC_TOKEN);
		pool = await ethers.getContractAt('ICurveStableSwapNG', addr.curveStableSwapNG_USDUUSDC);

		// deploy adapter
		const CurveAdapter = await ethers.getContractFactory('CurveAdapterV1');
		adapter = await CurveAdapter.deploy(addr.curveStableSwapNG_USDUUSDC, 0, 1);

		// fund curator with eth
		await module.sendTransaction({
			to: curator,
			value: parseEther('10'),
		});

		// activate modules
		await stable.connect(curator).setModule(module, expiredAt, 'module');
		await stable.connect(curator).setModule(adapter, expiredAt, 'curve');

		await evm_increaseTime(7 * 24 * 3600 + 100);

		await stable.acceptModule(module);
		await stable.acceptModule(adapter);
	});

	describe('Token Tests', function () {
		it('addresses of token', async function () {
			expect((await pool.coins(0)).toLowerCase()).to.be.equal(addr.usduStable.toLowerCase());
			expect((await pool.coins(1)).toLowerCase()).to.be.equal(USDC_TOKEN.toLowerCase());
		});

		it('should have correct balances as user', async function () {
			await stable.connect(module).mintModule(user, parseUnits(amount, 18));
			await usdc.connect(usdcUser).transfer(user, parseUnits(amount, 6));
			expect(await stable.balanceOf(user)).to.be.equal(parseUnits(amount, 18));
			expect(await usdc.balanceOf(user)).to.be.equal(parseUnits(amount, 6));
		});
	});

	describe('Curve Pool', function () {
		it('Let e.g. curator build up init liquidity each: ' + amount, async function () {
			const amount = '100000'; // overwrite amount

			await stable.connect(module).mintModule(curator, parseUnits(amount, 18));
			await usdc.connect(usdcUser).transfer(curator, parseUnits(amount, 6));

			expect(await stable.balanceOf(curator)).to.be.equal(parseUnits(amount, 18));
			expect(await usdc.balanceOf(curator)).to.be.equal(parseUnits(amount, 6));

			await stable.connect(curator).approve(await pool.getAddress(), parseUnits(amount, 18));
			await usdc.connect(curator).approve(await pool.getAddress(), parseUnits(amount, 6));

			await pool.connect(curator)['add_liquidity(uint256[],uint256)']([parseUnits(amount, 18), parseUnits(amount, 6)], 0);
		});

		it('should revert with NotUnderBalanced', async function () {
			await usdc.connect(usdcUser).transfer(user, parseUnits(amount, 6));
			await usdc.connect(user).approve(await adapter.getAddress(), parseUnits(amount, 6));
			await expect(adapter.connect(user).addLiquidity(parseUnits(amount, 6), 0n)).to.revertedWithCustomError(
				adapter,
				'NotUnderBalanced'
			);
		});

		it('user exchanges 10000 USDC to USDU, simulate imbalance', async function () {
			await usdc.connect(user).approve(await pool.getAddress(), parseUnits(amount, 6));
			await pool.connect(user)['exchange(int128,int128,uint256,uint256)'](1n, 0n, parseUnits(amount, 6), 0n);
			expect(await usdc.balanceOf(user)).to.be.equal(parseUnits(amount, 6));
			expect(await stable.balanceOf(user)).to.be.greaterThan(parseUnits('10000', 18));
		});

		it('should call addLiquidity as user', async function () {
			expect(await pool.balanceOf(user)).to.be.equal(0);
			await adapter.connect(user).addLiquidity(parseUnits(amount, 6), 0n);
			expect(await usdc.balanceOf(user)).to.be.equal(0);
			expect(await pool.balanceOf(user)).to.be.greaterThan(0);
		});

		it('should make a few trades as curator', async function () {
			await usdc.connect(usdcUser).transfer(curator, parseUnits(amount, 6));

			for (let i = 0; i < 100; i++) {
				const gotUsdc = await usdc.balanceOf(curator);
				await usdc.connect(curator).approve(await pool.getAddress(), gotUsdc);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](1n, 0n, gotUsdc, 0n);
				const gotStable = await stable.balanceOf(curator);
				await stable.connect(curator).approve(await pool.getAddress(), gotStable);
				await pool.connect(curator)['exchange(int128,int128,uint256,uint256)'](0, 1, gotStable, 0);
			}
		});

		it('should redeem all user lp shares', async function () {
			expect(await usdc.balanceOf(user)).to.be.equal(0);
			await pool.connect(user)['remove_liquidity_one_coin(uint256,int128,uint256)'](await pool.balanceOf(user), 1, 0);
			expect(await usdc.balanceOf(user)).to.be.greaterThan(parseUnits('10000', 6)); // 10016.515718 after 200x 10k trades
			expect(await pool.balanceOf(user)).to.be.equal(0);
		});

		it('should redeem all adapter lp shares', async function () {
			await adapter.connect(curator).redeem(await pool.balanceOf(await adapter.getAddress()), 0n);
			expect(await usdc.balanceOf(adapter)).to.be.equal(0);
			expect(await stable.balanceOf(adapter)).to.be.greaterThan(0);

			console.log({
				stable: await stable.balanceOf(adapter),
			});

			console.log(await pool.balances(0));
			console.log(await pool.balances(1));
		});
	});
});
