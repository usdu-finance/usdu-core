import { arbitrum, base, mainnet, optimism, polygon } from 'viem/chains';
import { ChainAddressMap } from './address.types';

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

		// ###############
		// Stablecoin USDU
		// ###############
		usduDeployer: '0x745211a1e1a58b2b11b932855b30d411c31e25d5',
		usduStable: '0xdde3ec717f220fc6a29d6a4be73f91da5b718e55',

		// curve pools
		// https://www.curve.finance/dex/ethereum/pools/factory-stable-ng-596
		curveStableSwapNG_USDCUSDU: '0x6C5Ff8DCe52BE77b4eCE6B51996018f0C1713bA9',
		curveStableSwapNG_USDCUSDU_gauge: '0xbB6eDb6E10fC89F1032F3c4DdB2e73d1BeDa423f',

		// swap modules and utils
		usduSwapRouterV1: '0x2A51F412B4E3fc3a43605B8EB9917facF5b5a08E',
		usduSwapBridgeMorphoV1_steakUSDC_vault: '0xbeef088055857739C12CD3765F20b7679Def0f51',
		usduSwapBridgeMorphoV1_steakUSDC_module: '0x6b6893d82edbC8d6769ba3c407102D33dA2B623f',
		usduSwapBridgeMorphoV1_steakUSDT_vault: '0xbeef003C68896c7D2c3c60d363e8d71a49Ab2bf9',
		usduSwapBridgeMorphoV1_steakUSDT_module: '0xd9141f634Ef9E871A5FE4f64195747DB77A13f3E',

		// ###############
		// Stablecoin EURU
		// ###############
		euruDeployer: '0xc005C5110e98978f780439eaA9E235c1F2469726',
		euruStable: '0x6e30d56cb23068dE5A084D4A4f2A909823424F06',

		// swap modules and utils
		euruSwapRouterV1: '0x6a5c8fC7d1697088Ff41F76Ca15C0eA59E02081c',
		euruSwapBridgeMorphoV1_steakEURC_vault: '0xbeef003E31546C7210687f1A7b40d096BE83ec58',
		euruSwapBridgeMorphoV1_steakEURC_module: '0x83F263eF950586Ce3C35D58930f0d2001fe79c50',

		// ##################
		// external protocols
		// ##################
		// https://docs.merkl.xyz/integrate-merkl/smart-contract-addresses — same address on mainnet, arbitrum, base, optimism, polygon
		merklDistributor: '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae',
	},
	[arbitrum.id]: {
		// identifier
		chainId: 42161,
		chainSelector: '4949039107694359620',

		// ##################
		// external protocols
		// ##################
		// https://docs.merkl.xyz/integrate-merkl/smart-contract-addresses — same address on mainnet, arbitrum, base, optimism, polygon
		merklDistributor: '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae',
	},
	[base.id]: {
		// identifier
		chainId: 8453,
		chainSelector: '15971525489660198786',

		// ##################
		// external protocols
		// ##################
		// https://docs.merkl.xyz/integrate-merkl/smart-contract-addresses — same address on mainnet, arbitrum, base, optimism, polygon
		merklDistributor: '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae',
	},
	[optimism.id]: {
		// identifier
		chainId: 10,
		chainSelector: '3734403246176062136',

		// ##################
		// external protocols
		// ##################
		// https://docs.merkl.xyz/integrate-merkl/smart-contract-addresses — same address on mainnet, arbitrum, base, optimism, polygon
		merklDistributor: '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae',
	},
	[polygon.id]: {
		// identifier
		chainId: 137,
		chainSelector: '4051577828743386545',

		// ##################
		// external protocols
		// ##################		// https://docs.merkl.xyz/integrate-merkl/smart-contract-addresses — same address on mainnet, arbitrum, base, optimism, polygon
		merklDistributor: '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae',
	},
} as const;
