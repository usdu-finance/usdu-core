export const MorphoAdapterV1_ABI = [
	{
		inputs: [
			{
				internalType: 'contract Stablecoin',
				name: '_stable',
				type: 'address',
			},
			{
				internalType: 'contract IMetaMorphoV1_1',
				name: '_core',
				type: 'address',
			},
			{
				internalType: 'contract IMetaMorphoV1_1',
				name: '_staked',
				type: 'address',
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
				internalType: 'address',
				name: 'forwardedTo',
				type: 'address',
			},
		],
		name: 'ForwardCallFailed',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'receivers',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'weights',
				type: 'uint256',
			},
		],
		name: 'MismatchLength',
		type: 'error',
	},
	{
		inputs: [],
		name: 'NoPendingValue',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'assets',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'minted',
				type: 'uint256',
			},
		],
		name: 'NothingToReconcile',
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
				indexed: false,
				internalType: 'uint256',
				name: 'amount',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'sharesCore',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'sharesStaked',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'totalMinted',
				type: 'uint256',
			},
		],
		name: 'Deposit',
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
				indexed: false,
				internalType: 'uint256',
				name: 'amount',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'sharesCore',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'sharesStaked',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'totalMinted',
				type: 'uint256',
			},
		],
		name: 'Redeem',
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
		inputs: [],
		name: 'applyDistribution',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'core',
		outputs: [
			{
				internalType: 'contract IMetaMorphoV1_1',
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
				name: 'amount',
				type: 'uint256',
			},
		],
		name: 'deposit',
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
		inputs: [],
		name: 'reconcile',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'sharesStaked',
				type: 'uint256',
			},
		],
		name: 'redeem',
		outputs: [],
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
		name: 'staked',
		outputs: [
			{
				internalType: 'contract IMetaMorphoV1_1',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'totalAssets',
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
