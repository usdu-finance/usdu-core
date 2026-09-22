import { ethers } from 'hardhat';
import * as helper from '@nomicfoundation/hardhat-network-helpers';

export const latestBlockNumber = async () => {
	return await ethers.provider.getBlockNumber();
};

/**
 * Re-forks the Hardhat network at `blockNumber`, overriding the global `hardhat.config.ts` pin
 * for the current test file only (network state resets between test files anyway). Needed when a
 * test depends on a contract that wasn't deployed yet at the config's default fork block.
 */
export const resetFork = async (blockNumber: number): Promise<void> => {
	const alchemy = process.env.ALCHEMY_RPC_KEY;
	await helper.reset(`https://eth-mainnet.g.alchemy.com/v2/${alchemy}`, blockNumber);
};

export const evm_increaseTime = async (seconds: number | bigint) => {
	await helper.time.increase(seconds);
	await helper.mine(1);
};

export const evm_increaseTimeTo = async (seconds: number | bigint) => {
	let latest = BigInt(await helper.time.latest());
	await helper.time.increase(BigInt(seconds) - latest);
};

export const evm_mine_blocks = async (n: number) => {
	await helper.mine(n);
};

export const getTimeStamp = async () => {
	const blockNumBefore = await ethers.provider.getBlockNumber();
	const blockBefore = await ethers.provider.getBlock(blockNumBefore);
	return blockBefore?.timestamp ?? null;
};

/**
 * Sets `holder`'s balance of a real (forked) ERC20 `token` to `amount`, without needing a whale account to
 * impersonate. Brute-forces the `balances` mapping's storage slot (tries 0..29, the standard OpenZeppelin/
 * Solidity layout for a token's first or near-first storage variable) by writing a candidate value and
 * checking `balanceOf` reflects it — so it works against proxied tokens (e.g. Circle's FiatToken contracts)
 * without hardcoding a layout that may not match every implementation.
 */
export const setERC20Balance = async (token: string, holder: string, amount: bigint): Promise<void> => {
	const erc20 = await ethers.getContractAt('IERC20', token);
	const value = ethers.zeroPadValue(ethers.toBeHex(amount), 32);

	for (let slot = 0; slot < 30; slot++) {
		const index = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [holder, slot]));
		const previous = await helper.getStorageAt(token, index);

		await helper.setStorageAt(token, index, value);
		if ((await erc20.balanceOf(holder)) === amount) return;

		await helper.setStorageAt(token, index, previous);
	}

	throw new Error(`setERC20Balance: could not find the balances slot for token ${token}`);
};
