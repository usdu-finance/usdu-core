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

	// curator / DAO
	curator: Address;
	aragonDao: Address;
	aragonMultiSig: Address;
	aragonDelayedAction: Address;
	aragonVetoMultiSig: Address;

	// deployer and stable
	usduDeployer: Address;
	usduStable: Address;

	// curve pools
	curveStableSwapNG_USDCUSDU: Address;
	curveStableSwapNG_USDCUSDU_gauge: Address;

	// external protocols
	merklDistributor: Address;

	// swap modules and utils
	swapRouterV1: Address;
	swapBridgeMorphoV1_steakUSDC_vault: Address;
	swapBridgeMorphoV1_steakUSDC_module: Address;
	swapBridgeMorphoV1_steakUSDT_vault: Address;
	swapBridgeMorphoV1_steakUSDT_module: Address;
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
