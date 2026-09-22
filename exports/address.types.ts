import { arbitrum, base, mainnet, optimism, polygon } from 'viem/chains';
import { Address, Chain } from 'viem';

// network and chains
export const ChainMain = { mainnet } as const;
export const ChainSide = {
	arbitrum,
	base,
	optimism,
	polygon,
} as const;

// supported chains
export const SupportedChains = { ...ChainMain, ...ChainSide } as const;
export type SupportedChain = (typeof SupportedChains)[keyof typeof SupportedChains];

export const SupportedChainsMap: { [K in ChainId]: SupportedChain | Chain } = {
	[mainnet.id]: mainnet,
	[arbitrum.id]: arbitrum,
	[base.id]: base,
	[optimism.id]: optimism,
	[polygon.id]: polygon,
} as const;

export const SupportedChainIds = Object.values(SupportedChains).map((chain) => chain.id);

// chain ids
export type ChainIdMain = typeof mainnet.id;

export type ChainIdSide = typeof arbitrum.id | typeof base.id | typeof optimism.id | typeof polygon.id;

export type ChainId = ChainIdMain | ChainIdSide;

// chain Address
export type ChainAddressMainnet = {
	// identifier
	chainId: typeof mainnet.id;
	chainSelector: string;

	// #############
	// curator / DAO
	// #############
	curator: Address;
	aragonDao: Address;
	aragonMultiSig: Address;
	aragonDelayedAction: Address;
	aragonVetoMultiSig: Address;

	// ###############
	// Stablecoin USDU
	// ###############
	usduDeployer: Address;
	usduStable: Address;

	// curve pools
	curveStableSwapNG_USDCUSDU: Address;
	curveStableSwapNG_USDCUSDU_gauge: Address;
	curveTwocryptoNG_USDUEURU: Address;
	curveTwocryptoNG_USDUCHFU: Address;

	// swap modules and utils
	usduSwapRouterV1: Address;
	usduSwapBridgeMorphoV1_steakUSDC_vault: Address;
	usduSwapBridgeMorphoV1_steakUSDC_module: Address;
	usduSwapBridgeMorphoV1_steakUSDT_vault: Address;
	usduSwapBridgeMorphoV1_steakUSDT_module: Address;

	// ###############
	// Stablecoin EURU
	// ###############
	euruDeployer: Address;
	euruStable: Address;

	// swap modules and utils
	euruSwapRouterV1: Address;
	euruSwapBridgeMorphoV1_steakEURC_vault: Address;
	euruSwapBridgeMorphoV1_steakEURC_module: Address;
	// euruSwapBridgeMorphoV1_EURCdEURO_vault: Address;
	// euruSwapBridgeMorphoV1_EURCdEURO_module: Address;

	// ###############
	// Stablecoin CHFU
	// ###############
	chfuDeployer: Address;
	chfuStable: Address;

	// swap modules and utils
	chfuSwapRouterV1: Address;
	chfuSwapBridgeMorphoV1_ZCHF_vault: Address;
	chfuSwapBridgeMorphoV1_ZCHF_module: Address;

	// ##################
	// external protocols
	// ##################
	merklDistributor: Address;
};

export type ChainAddressArbitrum = {
	// identifier
	chainId: typeof arbitrum.id;
	chainSelector: string;

	// external protocols
	merklDistributor: Address;
};

export type ChainAddressBase = {
	// identifier
	chainId: typeof base.id;
	chainSelector: string;

	// external protocols
	merklDistributor: Address;
};

export type ChainAddressOptimism = {
	// identifier
	chainId: typeof optimism.id;
	chainSelector: string;

	// external protocols
	merklDistributor: Address;
};

export type ChainAddressPolygon = {
	// identifier
	chainId: typeof polygon.id;
	chainSelector: string;

	// external protocols
	merklDistributor: Address;
};

// ChainAddressMap aggregation
export type ChainAddressMap = {
	[mainnet.id]: ChainAddressMainnet;
	[arbitrum.id]: ChainAddressArbitrum;
	[base.id]: ChainAddressBase;
	[optimism.id]: ChainAddressOptimism;
	[polygon.id]: ChainAddressPolygon;
};
