export const CurveSeedAdapterV1_ABI = [
	{
		inputs: [
			{ internalType: 'contract IStablecoinMetadata', name: '_usdu', type: 'address' },
			{ internalType: 'contract ITwocrypto[]', name: '_pools', type: 'address[]' },
		],
		stateMutability: 'nonpayable',
		type: 'constructor',
	},
	{ inputs: [{ internalType: 'contract ITwocrypto', name: 'pool', type: 'address' }], name: 'InvalidPool', type: 'error' },
	{ inputs: [{ internalType: 'contract ITwocrypto', name: 'pool', type: 'address' }], name: 'PoolNotAllowed', type: 'error' },
	{ inputs: [{ internalType: 'address', name: 'token', type: 'address' }], name: 'SafeERC20FailedOperation', type: 'error' },
	{ inputs: [], name: 'ZeroAmount', type: 'error' },
	{
		anonymous: false,
		inputs: [
			{ indexed: true, internalType: 'contract ITwocrypto', name: 'pool', type: 'address' },
			{ indexed: false, internalType: 'uint256', name: 'shares', type: 'uint256' },
			{ indexed: false, internalType: 'uint256[2]', name: 'withdrawn', type: 'uint256[2]' },
		],
		name: 'RemoveLiquidity',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{ indexed: true, internalType: 'contract ITwocrypto', name: 'pool', type: 'address' },
			{ indexed: false, internalType: 'uint256', name: 'repaidUsdu', type: 'uint256' },
			{ indexed: false, internalType: 'uint256', name: 'repaidOther', type: 'uint256' },
		],
		name: 'RepayDebt',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{ indexed: true, internalType: 'contract ITwocrypto', name: 'pool', type: 'address' },
			{ indexed: false, internalType: 'uint256', name: 'amountUsdu', type: 'uint256' },
			{ indexed: false, internalType: 'uint256', name: 'amountOther', type: 'uint256' },
			{ indexed: false, internalType: 'uint256', name: 'shares', type: 'uint256' },
		],
		name: 'Seed',
		type: 'event',
	},
	{
		inputs: [{ internalType: 'contract ITwocrypto', name: '', type: 'address' }],
		name: 'debts',
		outputs: [
			{ internalType: 'uint256', name: 'usdu', type: 'uint256' },
			{ internalType: 'uint256', name: 'other', type: 'uint256' },
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [{ internalType: 'contract ITwocrypto', name: '', type: 'address' }],
		name: 'isAllowedPool',
		outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'contract ITwocrypto', name: 'pool', type: 'address' },
			{ internalType: 'uint256', name: 'shares', type: 'uint256' },
			{ internalType: 'uint256[2]', name: 'minAmounts', type: 'uint256[2]' },
		],
		name: 'removeLiquidity',
		outputs: [{ internalType: 'uint256[2]', name: 'withdrawn', type: 'uint256[2]' }],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [{ internalType: 'contract ITwocrypto', name: 'pool', type: 'address' }],
		name: 'repayDebt',
		outputs: [
			{ internalType: 'uint256', name: 'repaidUsdu', type: 'uint256' },
			{ internalType: 'uint256', name: 'repaidOther', type: 'uint256' },
		],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'contract ITwocrypto', name: 'pool', type: 'address' },
			{ internalType: 'uint256', name: 'amountUsdu', type: 'uint256' },
			{ internalType: 'uint256', name: 'surplusBps', type: 'uint256' },
			{ internalType: 'uint256', name: 'minShares', type: 'uint256' },
		],
		name: 'seed',
		outputs: [{ internalType: 'uint256', name: 'shares', type: 'uint256' }],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'usdu',
		outputs: [{ internalType: 'contract IStablecoinMetadata', name: '', type: 'address' }],
		stateMutability: 'view',
		type: 'function',
	},
] as const;
