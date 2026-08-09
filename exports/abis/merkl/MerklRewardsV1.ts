export const MerklRewardsV1_ABI = [
	{ inputs: [], name: 'ReentrancyGuardReentrantCall', type: 'error' },
	{ inputs: [{ internalType: 'address', name: 'token', type: 'address' }], name: 'SafeERC20FailedOperation', type: 'error' },
	{
		anonymous: false,
		inputs: [
			{ indexed: true, internalType: 'address', name: 'token', type: 'address' },
			{ indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
			{ indexed: true, internalType: 'address', name: 'to', type: 'address' },
		],
		name: 'ClaimRewards',
		type: 'event',
	},
	{
		inputs: [
			{ internalType: 'address[]', name: 'tokens', type: 'address[]' },
			{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' },
			{ internalType: 'bytes32[][]', name: 'proofs', type: 'bytes32[][]' },
		],
		name: 'claimRewards',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'distributor',
		outputs: [{ internalType: 'contract IMerklDistributor', name: '', type: 'address' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'stable',
		outputs: [{ internalType: 'contract Stablecoin', name: '', type: 'address' }],
		stateMutability: 'view',
		type: 'function',
	},
] as const;
