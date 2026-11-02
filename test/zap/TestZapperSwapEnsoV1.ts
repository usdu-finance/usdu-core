import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther, parseUnits } from 'viem';
import { mainnet } from 'viem/chains';

import { ADDRESS } from '../../exports/address.config';
import {
	IERC20Metadata,
	Stablecoin,
	StreamerVaultV1,
	SwapBridgeMorphoV1,
	SwapRouterV1,
	TestVault4626,
	ZapperSwapEnsoV1,
} from '../../typechain';
import { evm_increaseTime, setERC20Balance } from '../helper';

// Kind enum of IZapperSwapEnsoV1
const Kind = { Call: 0, ModuleIn: 1, ModuleOut: 2, CurveStable: 3, CurveTwocrypto: 4, VaultDeposit: 5, VaultRedeem: 6 } as const;

describe('ZapperSwapEnsoV1', function () {
	const addr = ADDRESS[mainnet.id];

	const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
	const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
	const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
	const UNISWAP_ROUTER02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
	const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

	const MINT_CAP = parseEther('10000000');
	const SWAP_IN_FEE_PPM = 1_000n; // 0.1%
	const SWAP_OUT_FEE_PPM = 1_000n;

	const uniswap = new ethers.Interface([
		'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256)',
	]);
	// DAI -(0.01%)-> USDC and WETH -(0.05%)-> USDC
	const PATH_DAI_USDC = ethers.solidityPacked(['address', 'uint24', 'address'], [DAI, 100, USDC]);
	const PATH_WETH_USDC = ethers.solidityPacked(['address', 'uint24', 'address'], [WETH, 500, USDC]);

	let stable: Stablecoin;
	let usdc: IERC20Metadata;
	let dai: IERC20Metadata;
	let vault: TestVault4626;
	let bridge: SwapBridgeMorphoV1;
	let router: SwapRouterV1;
	let streamer: StreamerVaultV1;
	let zapper: ZapperSwapEnsoV1;

	let curator: SignerWithAddress;
	let deployer: SignerWithAddress;
	let user: SignerWithAddress;
	let recipient: SignerWithAddress;
	let stranger: SignerWithAddress;

	let bridgeAddr: string;
	let routerAddr: string;
	let zapperAddr: string;
	let streamerAddr: string;
	let timelock: bigint;

	before(async function () {
		[deployer, user, recipient, stranger] = await ethers.getSigners();

		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		curator = await ethers.getSigner(addr.curator);
		await deployer.sendTransaction({ to: curator.address, value: parseEther('10') });

		stable = await ethers.getContractAt('Stablecoin', addr.usduStable);
		usdc = await ethers.getContractAt('IERC20Metadata', USDC);
		dai = await ethers.getContractAt('IERC20Metadata', DAI);
		timelock = await stable.timelock();

		vault = await (await ethers.getContractFactory('TestVault4626')).deploy(USDC);
		bridge = await (
			await ethers.getContractFactory('SwapBridgeMorphoV1')
		).deploy(addr.usduStable, addr.merklDistributor, await vault.getAddress(), MINT_CAP, SWAP_IN_FEE_PPM, SWAP_OUT_FEE_PPM);
		router = await (await ethers.getContractFactory('SwapRouterV1')).deploy(addr.usduStable);
		streamer = await (
			await ethers.getContractFactory('StreamerVaultV1')
		).deploy(addr.usduStable, 7 * 24 * 3600, 'USDU Rewards', 'rUSDU');
		bridgeAddr = await bridge.getAddress();
		routerAddr = await router.getAddress();
		streamerAddr = await streamer.getAddress();

		const latest = BigInt((await ethers.provider.getBlock('latest'))!.timestamp);
		await stable.connect(curator).setModule(bridgeAddr, latest + timelock + 3650n * 24n * 60n * 60n, 'zapper-test');
		await evm_increaseTime(timelock + 100n);
		await stable.acceptModule(bridgeAddr);

		// Enso router: Uniswap standing in for it. Hop targets: the swap router, the vault and the Curve pool
		zapper = await (
			await ethers.getContractFactory('ZapperSwapEnsoV1')
		).deploy(UNISWAP_ROUTER02, [routerAddr, streamerAddr, addr.curveStableSwapNG_USDCUSDU]);
		zapperAddr = await zapper.getAddress();

		await setERC20Balance(USDC, user.address, parseUnits('1000000', 6));
		await setERC20Balance(DAI, user.address, parseEther('1000000'));
	});

	const moduleIn = (amountIn = 0n, minOut = 0n) => ({
		kind: Kind.ModuleIn,
		target: routerAddr,
		module: bridgeAddr,
		tokenIn: USDC,
		tokenOut: addr.usduStable,
		amountIn,
		minOut,
		i: 0,
		j: 0,
		value: 0,
		data: '0x',
	});

	const moduleOut = (amountIn = 0n, minOut = 0n) => ({
		...moduleIn(amountIn, minOut),
		kind: Kind.ModuleOut,
		tokenIn: addr.usduStable,
		tokenOut: USDC,
	});

	const vaultDeposit = (minOut = 0n) => ({
		kind: Kind.VaultDeposit,
		target: streamerAddr,
		module: ethers.ZeroAddress,
		tokenIn: addr.usduStable,
		tokenOut: streamerAddr,
		amountIn: 0n,
		minOut,
		i: 0,
		j: 0,
		value: 0,
		data: '0x',
	});

	const uniswapStep = (path: string, tokenIn: string, amountIn: bigint, value = 0n) => ({
		kind: Kind.Call,
		target: UNISWAP_ROUTER02,
		module: ethers.ZeroAddress,
		tokenIn,
		tokenOut: USDC,
		amountIn,
		minOut: 0n,
		i: 0,
		j: 0,
		value,
		data: uniswap.encodeFunctionData('exactInput', [{ path, recipient: zapperAddr, amountIn, amountOutMinimum: 0 }]),
	});

	const amountCoin = parseUnits('1000', 6);
	const mintedFor = (coin: bigint) =>
		parseEther(coin.toString()) / 10n ** 6n - ((parseEther(coin.toString()) / 10n ** 6n) * SWAP_IN_FEE_PPM) / 1_000_000n;

	async function expectEmpty() {
		expect(await usdc.balanceOf(zapperAddr)).to.equal(0n);
		expect(await dai.balanceOf(zapperAddr)).to.equal(0n);
		expect(await stable.balanceOf(zapperAddr)).to.equal(0n);
		expect(await streamer.balanceOf(zapperAddr)).to.equal(0n);
		expect(await ethers.provider.getBalance(zapperAddr)).to.equal(0n);
	}

	describe('Constructor', function () {
		it('fixes the Enso router and the hop targets it was deployed with, and keeps them apart', async function () {
			expect(await zapper.ensoRouter()).to.equal(UNISWAP_ROUTER02);
			for (const hop of [routerAddr, streamerAddr, addr.curveStableSwapNG_USDCUSDU]) {
				expect(await zapper.isHopTarget(hop)).to.equal(true);
			}
			expect(await zapper.isHopTarget(UNISWAP_ROUTER02)).to.equal(false);
			expect(await zapper.isHopTarget(USDC)).to.equal(false);
			expect(await zapper.NATIVE()).to.equal(NATIVE);
		});

		it('refuses to deploy with a hop target equal to the Enso router, or without a router', async function () {
			const Zapper = await ethers.getContractFactory('ZapperSwapEnsoV1');
			await expect(Zapper.deploy(streamerAddr, [streamerAddr]))
				.to.be.revertedWithCustomError(Zapper, 'HopTargetIsEnsoRouter')
				.withArgs(streamerAddr);
			await expect(Zapper.deploy(ethers.ZeroAddress, [routerAddr])).to.be.revertedWithCustomError(Zapper, 'ZeroEnsoRouter');
		});

		it('emits events for the router and every hop target so the allowlist can be indexed', async function () {
			const deployTx = zapper.deploymentTransaction()!;
			await expect(deployTx).to.emit(zapper, 'EnsoRouterSet').withArgs(UNISWAP_ROUTER02);
			await expect(deployTx).to.emit(zapper, 'HopTargetSet').withArgs(routerAddr);
		});

		it('has no owner or admin surface', async function () {
			const names = zapper.interface.fragments.filter((f) => f.type === 'function').map((f) => (f as any).name);
			expect(names).to.have.members(['NATIVE', 'ensoRouter', 'isHopTarget', 'zap']);
		});

		it('hands stranded ETH to the next zapper rather than locking it', async function () {
			await user.sendTransaction({ to: zapperAddr, value: parseEther('1') });
			await setERC20Balance(USDC, stranger.address, amountCoin);
			await usdc.connect(stranger).approve(zapperAddr, amountCoin);
			const before = await ethers.provider.getBalance(stranger.address);

			// any zap's refund step sweeps the zapper's whole ETH balance to its caller
			await zapper.connect(stranger).zap(USDC, amountCoin, [moduleIn()], addr.usduStable, 1n, recipient.address);

			expect(await ethers.provider.getBalance(zapperAddr)).to.equal(0n);
			expect((await ethers.provider.getBalance(stranger.address)) - before).to.be.greaterThan(parseEther('0.99'));
		});
	});

	describe('Native hops', function () {
		it('mints through a swap module and pays the recipient', async function () {
			await usdc.connect(user).approve(zapperAddr, amountCoin);
			const before = await stable.balanceOf(recipient.address);

			const tx = await zapper
				.connect(user)
				.zap(USDC, amountCoin, [moduleIn()], addr.usduStable, mintedFor(amountCoin), recipient.address);
			await expect(tx)
				.to.emit(zapper, 'Zap')
				.withArgs(user.address, recipient.address, USDC, amountCoin, ethers.getAddress(addr.usduStable), mintedFor(amountCoin));

			expect((await stable.balanceOf(recipient.address)) - before).to.equal(mintedFor(amountCoin));
			await expectEmpty();
		});

		it('chains a module swap into a vault stake with the whole balance of each step', async function () {
			await usdc.connect(user).approve(zapperAddr, amountCoin);
			const sharesBefore = await streamer.balanceOf(recipient.address);

			await zapper.connect(user).zap(USDC, amountCoin, [moduleIn(), vaultDeposit()], streamerAddr, 1n, recipient.address);

			// shares are 1:1 with assets in a fresh vault
			expect((await streamer.balanceOf(recipient.address)) - sharesBefore).to.equal(mintedFor(amountCoin));
			await expectEmpty();
		});

		it('unstakes from the vault back into the stablecoin', async function () {
			// the recipient holds rUSDU from the stake above
			const shares = (await streamer.balanceOf(recipient.address)) / 2n;
			await streamer.connect(recipient).approve(zapperAddr, shares);
			const expected = await streamer.previewRedeem(shares);
			const before = await stable.balanceOf(stranger.address);

			await zapper
				.connect(recipient)
				.zap(
					streamerAddr,
					shares,
					[{ ...vaultDeposit(), kind: Kind.VaultRedeem, tokenIn: streamerAddr, tokenOut: addr.usduStable }],
					addr.usduStable,
					expected,
					stranger.address
				);

			expect((await stable.balanceOf(stranger.address)) - before).to.equal(expected);
			await expectEmpty();
		});

		it('redeems through the module, minus the swap-out fee', async function () {
			// the recipient holds USDU from the zaps above
			const stableIn = parseEther('500');
			await stable.connect(recipient).approve(zapperAddr, stableIn);
			const before = await usdc.balanceOf(stranger.address);

			await zapper.connect(recipient).zap(addr.usduStable, stableIn, [moduleOut()], USDC, 1n, stranger.address);

			const out = stableIn - (stableIn * SWAP_OUT_FEE_PPM) / 1_000_000n;
			expect((await usdc.balanceOf(stranger.address)) - before).to.equal(out / 10n ** 12n);
			await expectEmpty();
		});

		it('refunds input the route did not consume', async function () {
			const spend = amountCoin / 2n;
			await usdc.connect(user).approve(zapperAddr, amountCoin);
			const before = await usdc.balanceOf(user.address);

			await zapper.connect(user).zap(USDC, amountCoin, [moduleIn(spend)], addr.usduStable, 1n, recipient.address);

			expect(before - (await usdc.balanceOf(user.address))).to.equal(spend);
			await expectEmpty();
		});
	});

	describe('Curve hops', function () {
		// USDC / USDU StableSwapNG pool: coin(0) USDC, coin(1) USDU
		it('swaps through a StableSwap NG pool in both directions', async function () {
			const pool = await ethers.getContractAt('ICurveStableSwapNG', addr.curveStableSwapNG_USDCUSDU);

			const step = (i: number, j: number, tokenIn: string, tokenOut: string) => ({
				kind: Kind.CurveStable,
				target: addr.curveStableSwapNG_USDCUSDU,
				module: ethers.ZeroAddress,
				tokenIn,
				tokenOut,
				amountIn: 0n,
				minOut: 0n,
				i,
				j,
				value: 0,
				data: '0x',
			});

			// USDC -> USDU
			const usdcIn = parseUnits('100', 6);
			const quoteUsdu = await pool.get_dy(0, 1, usdcIn);
			await usdc.connect(user).approve(zapperAddr, usdcIn);
			const before = await stable.balanceOf(stranger.address);
			await zapper
				.connect(user)
				.zap(USDC, usdcIn, [step(0, 1, USDC, addr.usduStable)], addr.usduStable, (quoteUsdu * 99n) / 100n, stranger.address);
			expect((await stable.balanceOf(stranger.address)) - before).to.equal(quoteUsdu);

			// USDU -> USDC
			const usduIn = parseEther('50');
			const quoteUsdc = await pool.get_dy(1, 0, usduIn);
			await stable.connect(stranger).approve(zapperAddr, usduIn);
			const usdcBefore = await usdc.balanceOf(recipient.address);
			await zapper
				.connect(stranger)
				.zap(addr.usduStable, usduIn, [step(1, 0, addr.usduStable, USDC)], USDC, (quoteUsdc * 99n) / 100n, recipient.address);
			expect((await usdc.balanceOf(recipient.address)) - usdcBefore).to.equal(quoteUsdc);
			expect(await usdc.allowance(zapperAddr, addr.curveStableSwapNG_USDCUSDU)).to.equal(0n);
			await expectEmpty();
		});
	});

	describe('Aggregator call', function () {
		it('swaps an arbitrary token into an entry coin, then runs the native hops', async function () {
			const daiIn = parseEther('1000');
			await dai.connect(user).approve(zapperAddr, daiIn);
			const sharesBefore = await streamer.balanceOf(recipient.address);

			await zapper
				.connect(user)
				.zap(
					DAI,
					daiIn,
					[uniswapStep(PATH_DAI_USDC, DAI, daiIn), moduleIn(), vaultDeposit()],
					streamerAddr,
					parseEther('990'),
					recipient.address
				);

			// ~1000 DAI -> ~1000 USDC -> ~999 USDU -> ~999 rUSDU
			const shares = (await streamer.balanceOf(recipient.address)) - sharesBefore;
			expect(shares).to.be.greaterThan(parseEther('990'));
			expect(shares).to.be.lessThan(parseEther('1000'));
			await expectEmpty();
			expect(await dai.allowance(zapperAddr, UNISWAP_ROUTER02)).to.equal(0n);
		});

		it('zaps in with ETH', async function () {
			const ethIn = parseEther('1');
			const before = await stable.balanceOf(recipient.address);

			await zapper
				.connect(user)
				.zap(
					NATIVE,
					ethIn,
					[{ ...uniswapStep(PATH_WETH_USDC, WETH, ethIn, ethIn), tokenIn: NATIVE }, moduleIn()],
					addr.usduStable,
					parseEther('100'),
					recipient.address,
					{
						value: ethIn,
					}
				);

			expect((await stable.balanceOf(recipient.address)) - before).to.be.greaterThan(parseEther('100'));
			await expectEmpty();
		});

		it('returns the ETH it did not spend', async function () {
			const ethIn = parseEther('2');
			const spent = parseEther('1');
			const before = await ethers.provider.getBalance(user.address);

			const tx = await zapper
				.connect(user)
				.zap(
					NATIVE,
					ethIn,
					[{ ...uniswapStep(PATH_WETH_USDC, WETH, spent, spent), tokenIn: NATIVE }, moduleIn()],
					addr.usduStable,
					1n,
					recipient.address,
					{
						value: ethIn,
					}
				);
			const receipt = await tx.wait();

			const gas = receipt!.gasUsed * receipt!.gasPrice;
			expect(before - (await ethers.provider.getBalance(user.address)) - gas).to.equal(spent);
			await expectEmpty();
		});
	});

	describe('Safety', function () {
		it('rejects a step whose target is not allowlisted (a token cannot be turned into a transferFrom)', async function () {
			const steal = new ethers.Interface(['function transferFrom(address,address,uint256) returns (bool)']).encodeFunctionData(
				'transferFrom',
				[user.address, stranger.address, 1n]
			);
			await usdc.connect(user).approve(zapperAddr, amountCoin);

			await expect(
				zapper
					.connect(stranger)
					.zap(DAI, 0n, [{ ...uniswapStep(PATH_DAI_USDC, DAI, 0n), target: USDC, data: steal }], USDC, 0n, stranger.address)
			)
				.to.be.revertedWithCustomError(zapper, 'TargetNotAllowed')
				.withArgs(USDC);
		});

		it('cannot be used to spend approvals on a vault share through a Call (the transferFrom exploit)', async function () {
			// the recipient holds rUSDU and has approved the zapper, e.g. to zap with it. rUSDU is a hop target and an ERC-20.
			const held = await streamer.balanceOf(recipient.address);
			await streamer.connect(recipient).approve(zapperAddr, held);
			const steal = new ethers.Interface(['function transferFrom(address,address,uint256) returns (bool)']).encodeFunctionData(
				'transferFrom',
				[recipient.address, stranger.address, held]
			);

			await expect(
				zapper
					.connect(stranger)
					.zap(
						DAI,
						0n,
						[{ ...uniswapStep(PATH_DAI_USDC, DAI, 0n), target: streamerAddr, data: steal }],
						USDC,
						0n,
						stranger.address
					)
			)
				.to.be.revertedWithCustomError(zapper, 'TargetNotAllowed')
				.withArgs(streamerAddr);
			expect(await streamer.balanceOf(stranger.address)).to.equal(0n);

			await streamer.connect(recipient).approve(zapperAddr, 0n);
		});

		it('only lets a Call go to the Enso router, e.g. when Enso ships a new router version', async function () {
			await expect(
				zapper
					.connect(user)
					.zap(DAI, 0n, [{ ...uniswapStep(PATH_DAI_USDC, DAI, 0n), target: stranger.address }], USDC, 0n, recipient.address)
			)
				.to.be.revertedWithCustomError(zapper, 'TargetNotAllowed')
				.withArgs(stranger.address);
		});

		it('does not accept the Enso router as a typed hop', async function () {
			await expect(
				zapper.connect(user).zap(USDC, 1n, [{ ...moduleIn(), target: UNISWAP_ROUTER02 }], addr.usduStable, 0n, recipient.address)
			)
				.to.be.revertedWithCustomError(zapper, 'TargetNotAllowed')
				.withArgs(UNISWAP_ROUTER02);
		});

		it('pays a stranded balance of the output token to the recipient, without counting it towards the minimum', async function () {
			const stranded = parseEther('7');
			await stable.connect(recipient).transfer(zapperAddr, stranded);
			await usdc.connect(user).approve(zapperAddr, amountCoin);
			const delivered = mintedFor(amountCoin);

			// minAmountOut only counts what the route delivers itself
			await expect(zapper.connect(user).zap(USDC, amountCoin, [moduleIn()], addr.usduStable, delivered + 1n, stranger.address))
				.to.be.revertedWithCustomError(zapper, 'InsufficientOutput')
				.withArgs(delivered, delivered + 1n);

			const before = await stable.balanceOf(stranger.address);
			await zapper.connect(user).zap(USDC, amountCoin, [moduleIn()], addr.usduStable, delivered, stranger.address);
			expect((await stable.balanceOf(stranger.address)) - before).to.equal(delivered + stranded);
			await expectEmpty();
		});

		it('only ever pulls the input from the caller', async function () {
			await usdc.connect(user).approve(zapperAddr, amountCoin);
			// stranger has no USDC and no allowance to the zapper, so their zap cannot use the user's approval
			await expect(zapper.connect(stranger).zap(USDC, amountCoin, [moduleIn()], addr.usduStable, 1n, stranger.address)).to.be
				.reverted;
		});

		it('reverts when the overall output is below minAmountOut', async function () {
			await usdc.connect(user).approve(zapperAddr, amountCoin);
			const out = mintedFor(amountCoin);
			await expect(zapper.connect(user).zap(USDC, amountCoin, [moduleIn()], addr.usduStable, out + 1n, recipient.address))
				.to.be.revertedWithCustomError(zapper, 'InsufficientOutput')
				.withArgs(out, out + 1n);
		});

		it('reverts when a step is below its own minOut', async function () {
			await usdc.connect(user).approve(zapperAddr, amountCoin);
			const out = mintedFor(amountCoin);
			await expect(zapper.connect(user).zap(USDC, amountCoin, [moduleIn(0n, out + 1n)], addr.usduStable, 0n, recipient.address))
				.to.be.revertedWithCustomError(zapper, 'InsufficientStepOutput')
				.withArgs(0, out, out + 1n);
		});

		it('reverts when a step delivers nothing of its tokenOut', async function () {
			await usdc.connect(user).approve(zapperAddr, amountCoin);
			// claims to receive DAI but the module mints USDU
			await expect(
				zapper.connect(user).zap(USDC, amountCoin, [{ ...moduleIn(), tokenOut: DAI }], addr.usduStable, 0n, recipient.address)
			).to.be.revertedWithCustomError(zapper, 'InsufficientStepOutput');
		});

		it('rejects a module the stablecoin does not know', async function () {
			await usdc.connect(user).approve(zapperAddr, amountCoin);
			await expect(
				zapper
					.connect(user)
					.zap(USDC, amountCoin, [{ ...moduleIn(), module: stranger.address }], addr.usduStable, 0n, recipient.address)
			).to.be.reverted;
		});

		it('rejects malformed zaps', async function () {
			await expect(zapper.connect(user).zap(USDC, 1n, [], addr.usduStable, 0n, recipient.address)).to.be.revertedWithCustomError(
				zapper,
				'NoSteps'
			);
			await expect(zapper.connect(user).zap(USDC, 1n, [moduleIn()], USDC, 0n, recipient.address)).to.be.revertedWithCustomError(
				zapper,
				'SameToken'
			);
			await expect(
				zapper.connect(user).zap(USDC, 1n, [moduleIn()], addr.usduStable, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(zapper, 'ZeroRecipient');
			await expect(
				zapper.connect(user).zap(USDC, 1n, [moduleIn()], addr.usduStable, 0n, recipient.address, { value: 1n })
			).to.be.revertedWithCustomError(zapper, 'BadValue');
			await expect(
				zapper.connect(user).zap(NATIVE, 2n, [moduleIn()], addr.usduStable, 0n, recipient.address, { value: 1n })
			).to.be.revertedWithCustomError(zapper, 'BadValue');
			await expect(
				zapper.connect(user).zap(USDC, 1n, [{ ...moduleIn(), tokenOut: USDC }], addr.usduStable, 0n, recipient.address)
			).to.be.revertedWithCustomError(zapper, 'BadStep');
		});

		it('does not let a step call the zapper itself', async function () {
			// the zapper is never on its own allowlist; nonReentrant additionally covers any allowlisted target calling back
			await expect(
				zapper
					.connect(user)
					.zap(
						USDC,
						1n,
						[{ ...moduleIn(), kind: Kind.Call, target: zapperAddr, data: '0x' }],
						addr.usduStable,
						0n,
						recipient.address
					)
			).to.be.revertedWithCustomError(zapper, 'TargetNotAllowed');
		});
	});
});
