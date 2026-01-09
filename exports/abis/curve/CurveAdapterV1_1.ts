export const CurveAdapterV1_1_ABI = [
	{
		inputs: [
			{
				internalType: 'contract ICurveStableSwapNG',
				name: '_pool',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: '_idxS',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: '_idxC',
				type: 'uint256',
			},
			{
				internalType: 'address[5]',
				name: '_receivers',
				type: 'address[5]',
			},
			{
				internalType: 'uint32[5]',
				name: '_weights',
				type: 'uint32[5]',
			},
		],
		stateMutability: 'nonpayable',
		type: 'constructor',
	},
	{
		inputs: [],
		name: 'AlreadyPending',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'uint256[]',
				name: 'balances',
				type: 'uint256[]',
			},
		],
		name: 'ImbalancedVariant',
		type: 'error',
	},
	{
		inputs: [],
		name: 'NoPendingValue',
		type: 'error',
	},
	{
		inputs: [],
		name: 'NotProfitable',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
		],
		name: 'SafeERC20FailedOperation',
		type: 'error',
	},
	{
		inputs: [],
		name: 'TimelockNotElapsed',
		type: 'error',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'sender',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'minted',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'totalMinted',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'sharesMinted',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'totalShares',
				type: 'uint256',
			},
		],
		name: 'AddLiquidity',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'receiver',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'amount',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'ratio',
				type: 'uint256',
			},
		],
		name: 'Distribution',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'sender',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'burned',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'totalMinted',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'sharesBurned',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'totalShares',
				type: 'uint256',
			},
		],
		name: 'RemoveLiquidity',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: 'uint256',
				name: 'amount',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'totalRevenue',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'totalMinted',
				type: 'uint256',
			},
		],
		name: 'Revenue',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'caller',
				type: 'address',
			},
		],
		name: 'RevokeDistribution',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'caller',
				type: 'address',
			},
		],
		name: 'SetDistribution',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'caller',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'address[5]',
				name: 'receivers',
				type: 'address[5]',
			},
			{
				indexed: false,
				internalType: 'uint32[5]',
				name: 'weights',
				type: 'uint32[5]',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'timelock',
				type: 'uint256',
			},
		],
		name: 'SubmitDistribution',
		type: 'event',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'amount',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'minShares',
				type: 'uint256',
			},
		],
		name: 'addLiquidity',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'applyDistribution',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'beforeLP',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'afterLP',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'split',
				type: 'uint256',
			},
		],
		name: 'calcProfitability',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'checkImbalance',
		outputs: [
			{
				internalType: 'bool',
				name: '',
				type: 'bool',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'coin',
		outputs: [
			{
				internalType: 'contract IERC20Metadata',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'idxC',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'idxS',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'payOffDebt',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		name: 'pendingReceivers',
		outputs: [
			{
				internalType: 'address',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'pendingValidAt',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		name: 'pendingWeights',
		outputs: [
			{
				internalType: 'uint32',
				name: '',
				type: 'uint32',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'pool',
		outputs: [
			{
				internalType: 'contract ICurveStableSwapNG',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		name: 'receivers',
		outputs: [
			{
				internalType: 'address',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'shares',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'minAmount',
				type: 'uint256',
			},
		],
		name: 'redeem',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'shares',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'minAmount',
				type: 'uint256',
			},
		],
		name: 'removeLiquidity',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'revokePendingDistribution',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address[5]',
				name: '_receivers',
				type: 'address[5]',
			},
			{
				internalType: 'uint32[5]',
				name: '_weights',
				type: 'uint32[5]',
			},
		],
		name: 'setDistribution',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'stable',
		outputs: [
			{
				internalType: 'contract Stablecoin',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'totalMinted',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'totalRevenue',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'totalWeights',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'bool',
				name: 'state',
				type: 'bool',
			},
		],
		name: 'verifyImbalance',
		outputs: [],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		name: 'weights',
		outputs: [
			{
				internalType: 'uint32',
				name: '',
				type: 'uint32',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
] as const;
