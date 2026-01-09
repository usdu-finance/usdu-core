import { arbitrum, avalanche, base, gnosis, mainnet, optimism, polygon, sonic } from 'viem/chains';
import { Address, Chain } from 'viem';

// network and chains
export const ChainMain = { mainnet } as const;
export const ChainSide = {
	polygon,
	arbitrum,
	optimism,
	base,
	avalanche,
	gnosis,
	sonic,
} as const;

// supported chains
export const SupportedChains = { ...ChainMain, ...ChainSide } as const;
export type SupportedChain = (typeof SupportedChains)[keyof typeof SupportedChains];

export const SupportedChainsMap: { [K in ChainId]: SupportedChain | Chain } = {
	[mainnet.id]: mainnet,
	[polygon.id]: polygon,
	[arbitrum.id]: arbitrum,
	[optimism.id]: optimism,
	[base.id]: base,
	[avalanche.id]: avalanche,
	[gnosis.id]: gnosis,
	[sonic.id]: sonic,
} as const;

export const SupportedChainIds = Object.values(SupportedChains).map((chain) => chain.id);

// chain ids
export type ChainIdMain = typeof mainnet.id;

export type ChainIdSide =
	| typeof polygon.id
	| typeof arbitrum.id
	| typeof optimism.id
	| typeof base.id
	| typeof avalanche.id
	| typeof gnosis.id
	| typeof sonic.id;

export type ChainId = ChainIdMain | ChainIdSide;

// chain Address
export type ChainAddressMainnet = {
	// identifier
	chainId: typeof mainnet.id;
	chainSelector: string;

	// curator
	curator: Address;
	aragonMultiSig: Address;
	aragonVetoMultiSig: Address;
	aragonDelayedAction: Address;

	// morpho related
	morphoBlue: Address;
	morphoIrm: Address;
	morphoChainlinkOracleV2Factory: Address;
	morphoMetaMorphoFactory1_1: Address;
	morphoPublicAllocator: Address;
	morphoURD: Address;

	// USDU related
	usduDeployer: Address;
	usduStable: Address;
	usduCoreVault: Address;
	usduStakedVault: Address;
	usduRewardRouterV0: Address;
	usduMorphoAdapterV1: Address;
	usduMorphoAdapterV1_1: Address;
	usduMorphoAdapterV1_2: Address;
	usduCurveAdapterV1_USDC: Address;
	usduCurveAdapterV1_1_USDC: Address;
	usduCurveAdapterV1_1_USDC_2: Address;

	// core vault market ids
	marketIdUSDUIdle: Address;
	marketIdUSDUUSDC: Address;
	marketIdUSDUWETH: Address;
	marketIdUSDUCBBTC: Address;
	marketIdUSDUCurveLPUSDC: Address;

	// cross market ids
	marketIdUSDCUSDU: Address;
	marketIdUSDCSUSDU: Address;

	// curve pools
	curveStableSwapNG_USDUUSDC: Address;
	curveStableSwapNG_USDUUSDC_2: Address;
	curveStableSwapNG_USDUUSDC_LP_PriceAdapter: Address;
	curveStableSwapNG_USDUUSDC_LP_PriceOracle: Address;

	// term-max vaults
	termmaxVaultUSDU_Core: Address;
	termmaxVaultUSDU_RWA: Address;
	termmaxVaultUSDU_Yield: Address;

	// term-max adapters
	termmaxVaultAdapterRecoverV1_Core: Address;
	termmaxVaultAdapterRecoverV1_RWA: Address;
	termmaxVaultAdapterRecoverV1_Yield: Address;

	// erc20 tokens
	usdc: Address;
	WETH: Address;
	cbBTC: Address;
};

export type ChainAddressPolygon = {
	// identifier
	chainId: typeof polygon.id;
	chainSelector: string;
};

export type ChainAddressArbitrum = {
	// identifier
	chainId: typeof arbitrum.id;
	chainSelector: string;
};

export type ChainAddressOptimism = {
	// identifier
	chainId: typeof optimism.id;
	chainSelector: string;
};

export type ChainAddressBase = {
	// identifier
	chainId: typeof base.id;
	chainSelector: string;
};

export type ChainAddressAvalanche = {
	// identifier
	chainId: typeof avalanche.id;
	chainSelector: string;
};

export type ChainAddressGnosis = {
	// identifier
	chainId: typeof gnosis.id;
	chainSelector: string;
};

export type ChainAddressSonic = {
	// identifier
	chainId: typeof sonic.id;
	chainSelector: string;
};

// ChainAddressMap aggregation
export type ChainAddressMap = {
	[mainnet.id]: ChainAddressMainnet;
	[polygon.id]: ChainAddressPolygon;
	[arbitrum.id]: ChainAddressArbitrum;
	[optimism.id]: ChainAddressOptimism;
	[base.id]: ChainAddressBase;
	[avalanche.id]: ChainAddressAvalanche;
	[gnosis.id]: ChainAddressGnosis;
	[sonic.id]: ChainAddressSonic;
};
