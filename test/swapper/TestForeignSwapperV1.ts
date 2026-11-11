import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther } from 'viem';
import { mainnet } from 'viem/chains';

import { ADDRESS } from '../../exports/address.config';
import { ForeignSwapperV1, Stablecoin, TestSwapRouter, TestToken } from '../../typechain';

describe('ForeignSwapperV1', function () {
	const addr = ADDRESS[mainnet.id];
	const E18 = 10n ** 18n;

	let stable: Stablecoin;
	let swapper: ForeignSwapperV1;
	let router: TestSwapRouter;
	let foreign: TestToken;
	let mid: TestToken;
	let target: TestToken;

	let curator: SignerWithAddress;
	let deployer: SignerWithAddress;
	let caller: SignerWithAddress;

	let swapperAddr: string;
	let routerAddr: string;
	let foreignAddr: string;
	let midAddr: string;
	let targetAddr: string;

	const routerIface = new ethers.Interface(['function swap(address,address,uint256,address)']);
	// amount word sits after the selector and the two token words
	const AMOUNT_OFFSET = 4 + 32 + 32;

	const stepData = (tokenIn: string, tokenOut: string) =>
		routerIface.encodeFunctionData('swap', [tokenIn, tokenOut, 1n, swapperAddr]);

	const route = (over: any = {}) => ({
		enabled: true,
		tokenOut: targetAddr,
		minRate: E18,
		maxAmount: 0n,
		minAmount: 0n,
		steps: [
			{ target: routerAddr, tokenIn: foreignAddr, tokenOut: midAddr, patchAmount: true, amountOffset: AMOUNT_OFFSET, data: stepData(foreignAddr, midAddr) },
			{ target: routerAddr, tokenIn: midAddr, tokenOut: targetAddr, patchAmount: true, amountOffset: AMOUNT_OFFSET, data: stepData(midAddr, targetAddr) },
		],
		...over,
	});

	before(async function () {
		[deployer, caller] = await ethers.getSigners();

		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		curator = await ethers.getSigner(addr.curator);
		await deployer.sendTransaction({ to: curator.address, value: parseEther('10') });

		stable = await ethers.getContractAt('Stablecoin', addr.usduStable);

		const T = await ethers.getContractFactory('TestToken');
		foreign = await T.deploy('Foreign', 'FRN');
		mid = await T.deploy('Mid', 'MID');
		target = await T.deploy('Target', 'TGT');
		router = await (await ethers.getContractFactory('TestSwapRouter')).deploy();
		swapper = await (await ethers.getContractFactory('ForeignSwapperV1')).deploy(addr.usduStable);

		swapperAddr = await swapper.getAddress();
		routerAddr = await router.getAddress();
		foreignAddr = await foreign.getAddress();
		midAddr = await mid.getAddress();
		targetAddr = await target.getAddress();

		// the router's stock of the tokens it pays out, the DAO's foreign holdings and approval
		await mid.mint(1_000_000n * E18);
		await target.mint(1_000_000n * E18);
		await mid.transfer(routerAddr, 1_000_000n * E18);
		await target.transfer(routerAddr, 1_000_000n * E18);
		await foreign.mint(1_000n * E18);
		await foreign.transfer(curator.address, 1_000n * E18);
		await foreign.connect(curator).approve(swapperAddr, ethers.MaxUint256);
	});

	it('only the curator sets a route', async function () {
		await expect(swapper.connect(caller).setRoute(foreignAddr, route())).to.be.reverted;
	});

	it('rejects malformed routes', async function () {
		const s = route().steps;
		await expect(swapper.connect(curator).setRoute(foreignAddr, route({ steps: [] }))).to.be.revertedWithCustomError(swapper, 'BadRoute');
		await expect(swapper.connect(curator).setRoute(foreignAddr, route({ minRate: 0n }))).to.be.revertedWithCustomError(swapper, 'BadRoute');
		await expect(swapper.connect(curator).setRoute(foreignAddr, route({ tokenOut: foreignAddr }))).to.be.revertedWithCustomError(swapper, 'BadRoute');
		// broken chain
		await expect(swapper.connect(curator).setRoute(foreignAddr, route({ steps: [s[1]] }))).to.be.revertedWithCustomError(swapper, 'BadRoute');
		// a step must never target the foreign token (or the swapper)
		await expect(
			swapper.connect(curator).setRoute(foreignAddr, route({ steps: [{ ...s[0], target: foreignAddr }, s[1]] })),
		).to.be.revertedWithCustomError(swapper, 'BadRoute');
		await expect(
			swapper.connect(curator).setRoute(foreignAddr, route({ steps: [{ ...s[0], target: swapperAddr }, s[1]] })),
		).to.be.revertedWithCustomError(swapper, 'BadRoute');
		// amount patch must fit into the payload
		await expect(
			swapper.connect(curator).setRoute(foreignAddr, route({ steps: [{ ...s[0], amountOffset: 500 }, s[1]] })),
		).to.be.revertedWithCustomError(swapper, 'BadRoute');
	});

	it('reverts without a route', async function () {
		await expect(swapper.connect(caller).swap(foreignAddr)).to.be.revertedWithCustomError(swapper, 'RouteNotEnabled');
	});

	it('anyone converts the DAO balance and everything is swept to the DAO', async function () {
		await swapper.connect(curator).setRoute(foreignAddr, route());
		expect(await swapper.swappable(foreignAddr)).to.equal(1_000n * E18);

		await expect(swapper.connect(caller).swap(foreignAddr))
			.to.emit(swapper, 'Swapped')
			.withArgs(caller.address, curator.address, foreignAddr, targetAddr, 1_000n * E18, 1_000n * E18);

		expect(await foreign.balanceOf(curator.address)).to.equal(0);
		expect(await target.balanceOf(curator.address)).to.equal(1_000n * E18);
		for (const t of [foreign, mid, target]) expect(await t.balanceOf(swapperAddr)).to.equal(0);
		expect(await foreign.allowance(swapperAddr, routerAddr)).to.equal(0);
		await expect(swapper.connect(caller).swap(foreignAddr)).to.be.revertedWithCustomError(swapper, 'NothingToSwap');
	});

	it('respects maxAmount, minAmount and the allowance', async function () {
		await foreign.mint(500n * E18);
		await foreign.transfer(curator.address, 500n * E18);
		await swapper.connect(curator).setRoute(foreignAddr, route({ maxAmount: 200n * E18, minAmount: 100n * E18 }));
		expect(await swapper.swappable(foreignAddr)).to.equal(200n * E18);

		await foreign.connect(curator).approve(swapperAddr, 50n * E18);
		expect(await swapper.swappable(foreignAddr)).to.equal(0); // below minAmount
		await foreign.connect(curator).approve(swapperAddr, 150n * E18);
		await swapper.connect(caller).swap(foreignAddr);
		expect(await foreign.balanceOf(curator.address)).to.equal(350n * E18);
	});

	it('reverts when the route delivers less than minRate', async function () {
		await foreign.connect(curator).approve(swapperAddr, ethers.MaxUint256);
		await swapper.connect(curator).setRoute(foreignAddr, route({ minRate: (E18 * 99n) / 100n }));
		await router.setRate((E18 * 98n) / 100n); // each of the two hops loses 2%
		await expect(swapper.connect(caller).swap(foreignAddr)).to.be.revertedWithCustomError(swapper, 'InsufficientOutput');
		await router.setRate(E18);
		await swapper.connect(caller).swap(foreignAddr);
		expect(await foreign.balanceOf(curator.address)).to.equal(0);
	});

	it('guardian or curator can disable a route, strangers cannot', async function () {
		await expect(swapper.connect(caller).disableRoute(foreignAddr)).to.be.reverted;
		await expect(swapper.connect(curator).disableRoute(foreignAddr)).to.emit(swapper, 'RouteDisabled').withArgs(foreignAddr);
		expect(await swapper.swappable(foreignAddr)).to.equal(0);
		await expect(swapper.connect(caller).swap(foreignAddr)).to.be.revertedWithCustomError(swapper, 'RouteNotEnabled');
	});

	it('unwraps a vault share held by the DAO, then swaps', async function () {
		const vault = await (await ethers.getContractFactory('TestVault4626')).deploy(midAddr);
		const vaultAddr = await vault.getAddress();
		await mid.mint(105n * E18);
		await mid.approve(vaultAddr, 100n * E18);
		await vault.deposit(100n * E18, curator.address);
		await mid.transfer(vaultAddr, 5n * E18); // yield: share price > 1
		const shares = await vault.balanceOf(curator.address);
		await vault.connect(curator).approve(swapperAddr, ethers.MaxUint256);

		const redeem = new ethers.Interface(['function redeem(uint256,address,address)']).encodeFunctionData('redeem', [1n, swapperAddr, swapperAddr]);
		const r = route({
			steps: [
				{ target: vaultAddr, tokenIn: vaultAddr, tokenOut: midAddr, patchAmount: true, amountOffset: 4, data: redeem },
				{ target: routerAddr, tokenIn: midAddr, tokenOut: targetAddr, patchAmount: true, amountOffset: AMOUNT_OFFSET, data: stepData(midAddr, targetAddr) },
			],
		});
		await swapper.connect(curator).setRoute(vaultAddr, r);

		const before = await target.balanceOf(curator.address);
		await swapper.connect(caller).swap(vaultAddr);
		expect(await vault.balanceOf(curator.address)).to.equal(0);
		expect((await target.balanceOf(curator.address)) - before).to.be.closeTo((shares * 105n) / 100n, 10n); // vault rounds down

		// the foreign token itself is only callable for redeem / withdraw
		const tf = new ethers.Interface(['function transferFrom(address,address,uint256)']).encodeFunctionData('transferFrom', [curator.address, caller.address, 1n]);
		await expect(
			swapper.connect(curator).setRoute(vaultAddr, { ...r, steps: [{ ...r.steps[0], data: tf }, r.steps[1]] }),
		).to.be.revertedWithCustomError(swapper, 'BadRoute');
	});
});
