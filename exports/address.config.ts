import { arbitrum, base, citrea, mainnet } from 'viem/chains';
import { ChainAddressMap } from './address.types';
import { zeroAddress } from 'viem';

export const ADDRESS: ChainAddressMap = {
	[mainnet.id]: {
		// identifier
		chainId: 1,
		chainSelector: '5009297550715157269',

		// curator / DAO
		curator: '0x9fe66037c44236c87D9Ac8345F489b4413fDFf06',
		aragonDao: '0x9fe66037c44236c87D9Ac8345F489b4413fDFf06',
		aragonMultiSig: '0x369C21c8cB56C0211772F003c917b2807204BB4D',
		aragonDelayedAction: '0x8E8Bec995809bF29712C89149603a8C48329aF51',
		aragonVetoMultiSig: '0xF786531776903BaE94A1A4f4F17a0233dca5f9d5',

		// deployer and stable
		usduDeployer: '0x745211a1e1a58b2b11b932855b30d411c31e25d5',
		usduStable: '0xdde3ec717f220fc6a29d6a4be73f91da5b718e55',

		// curve pools
		// https://www.curve.finance/dex/ethereum/pools/factory-stable-ng-596
		curveStableSwapNG_USDCUSDU: '0x6C5Ff8DCe52BE77b4eCE6B51996018f0C1713bA9',
		curveStableSwapNG_USDCUSDU_gauge: '0xbB6eDb6E10fC89F1032F3c4DdB2e73d1BeDa423f',
	},
	[arbitrum.id]: {
		// identifier
		chainId: 42161,
		chainSelector: '4949039107694359620',
	},
	[base.id]: {
		// identifier
		chainId: 8453,
		chainSelector: '15971525489660198786',
	},
	[citrea.id]: {
		// identifier
		chainId: 4114,
		chainSelector: '', // not yet listed in the Chainlink CCIP directory
	},
} as const;
