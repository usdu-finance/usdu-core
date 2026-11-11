import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther } from 'viem';
import { mainnet } from 'viem/chains';

import { ADDRESS } from '../../exports/address.config';
import { ForeignSwapperV1 } from '../../typechain';
import { setERC20Balance } from '../helper';

// svDEURO, the dEURO <-> EURC bridge and EURU post-date the block the other tests fork, so this one forks later
const FORK_BLOCK = 26393680;

describe('ForeignSwapperV1 - live route', function () {
	const addr = ADDRESS[mainnet.id];
	const E18 = 10n ** 18n;

	let swapper: ForeignSwapperV1;
	let swapperAddr: string;
	let curator: SignerWithAddress;
	let caller: SignerWithAddress;

	before(async function () {
		await network.provider.request({
			method: 'hardhat_reset',
			params: [{ forking: { jsonRpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_RPC_KEY}`, blockNumber: FORK_BLOCK } }],
		});
		[caller] = await ethers.getSigners();
		await network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr.curator] });
		curator = await ethers.getSigner(addr.curator);
		await network.provider.send('hardhat_setBalance', [curator.address, '0x' + parseEther('10').toString(16)]);
		await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1']);

		swapper = await (await ethers.getContractFactory('ForeignSwapperV1')).deploy(addr.usduStable);
		swapperAddr = await swapper.getAddress();
	});

	after(async function () {
		// back to the config's fork for any test file that runs after this one
		await network.provider.request({ method: 'hardhat_reset', params: [{ forking: { jsonRpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_RPC_KEY}`, blockNumber: 24244916 } }] });
	});

	it('real route: svDEURO -> dEURO -> EURC (dEURO bridge) -> EURU (swap bridge)', async function () {
		const SV = '0x1F0e1d27b3D7F8A73D03a10D3078C32933297e90';
		const DEURO = '0xbA3f535bbCcCcA2A154b573Ca6c5A49BAAE0a3ea';
		const EURC = '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c';
		const BRIDGE = '0xdcc4835B34b4c05eB28B8defaC4d03d00842c2dF';
		const euru = addr.euruStable;

		const redeem = new ethers.Interface(['function redeem(uint256,address,address)']).encodeFunctionData('redeem', [1n, swapperAddr, swapperAddr]);
		const burn = new ethers.Interface(['function burnAndSend(address,uint256)']).encodeFunctionData('burnAndSend', [swapperAddr, 1n]);
		const swapIn = new ethers.Interface(['function swapInTo(address,address,uint256)']).encodeFunctionData('swapInTo', [
			addr.euruSwapBridgeMorphoV1_steakEURC_module, swapperAddr, 1n,
		]);

		await setERC20Balance(SV, curator.address, 1_000n * E18);
		const sv = await ethers.getContractAt('IERC20Metadata', SV);
		await sv.connect(curator).approve(swapperAddr, ethers.MaxUint256);

		await swapper.connect(curator).setRoute(SV, {
			enabled: true,
			tokenOut: euru,
			minRate: (E18 * 99n) / 100n, // share price is > 1 dEURO, fees well below 1%
			maxAmount: 0n,
			minAmount: 0n,
			steps: [
				{ target: SV, tokenIn: SV, tokenOut: DEURO, patchAmount: true, amountOffset: 4, data: redeem },
				{ target: BRIDGE, tokenIn: DEURO, tokenOut: EURC, patchAmount: true, amountOffset: 36, data: burn },
				{ target: addr.euruSwapRouterV1, tokenIn: EURC, tokenOut: euru, patchAmount: true, amountOffset: 68, data: swapIn },
			],
		});

		const euruToken = await ethers.getContractAt('IERC20Metadata', euru);
		const before = await euruToken.balanceOf(curator.address);
		await expect(swapper.connect(caller).swap(SV)).to.emit(swapper, 'Swapped');
		// the vault's fee recipient is the DAO, so redeeming mints it a sliver of fee shares
		expect(await sv.balanceOf(curator.address)).to.be.lt(E18);
		expect((await euruToken.balanceOf(curator.address)) - before).to.be.gt((990n * E18) / 1n);
		for (const t of [SV, DEURO, EURC, euru]) {
			expect(await (await ethers.getContractAt('IERC20Metadata', t)).balanceOf(swapperAddr)).to.equal(0);
		}
	});
});
