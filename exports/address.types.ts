import { arbitrum, base, citrea, mainnet } from 'viem/chains';
import { Address, Chain } from 'viem';

// network and chains
export const ChainMain = { mainnet } as const;
export const ChainSide = {
	arbitrum,
	base,
	citrea,
} as const;

// supported chains
export const SupportedChains = { ...ChainMain, ...ChainSide } as const;
export type SupportedChain = (typeof SupportedChains)[keyof typeof SupportedChains];

export const SupportedChainsMap: { [K in ChainId]: SupportedChain | Chain } = {
	[mainnet.id]: mainnet,
	[arbitrum.id]: arbitrum,
	[base.id]: base,
	[citrea.id]: citrea,
} as const;

export const SupportedChainIds = Object.values(SupportedChains).map((chain) => chain.id);

// chain ids
export type ChainIdMain = typeof mainnet.id;

export type ChainIdSide = typeof arbitrum.id | typeof base.id | typeof citrea.id;

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
};

export type ChainAddressArbitrum = {
	// identifier
	chainId: typeof arbitrum.id;
	chainSelector: string;
};

export type ChainAddressBase = {
	// identifier
	chainId: typeof base.id;
	chainSelector: string;
};

export type ChainAddressCitrea = {
	// identifier
	chainId: typeof citrea.id;
	chainSelector: string;
};

// ChainAddressMap aggregation
export type ChainAddressMap = {
	[mainnet.id]: ChainAddressMainnet;
	[arbitrum.id]: ChainAddressArbitrum;
	[base.id]: ChainAddressBase;
	[citrea.id]: ChainAddressCitrea;
};
