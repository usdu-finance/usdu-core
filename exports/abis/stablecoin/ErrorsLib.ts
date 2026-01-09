export const ErrorsLib_ABI = [
	{
		inputs: [],
		name: 'AboveMaxTimelock',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'account',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'since',
				type: 'uint256',
			},
		],
		name: 'AccountFreezed',
		type: 'error',
	},
	{
		inputs: [],
		name: 'AlreadyPending',
		type: 'error',
	},
	{
		inputs: [],
		name: 'AlreadySet',
		type: 'error',
	},
	{
		inputs: [],
		name: 'BelowMinTimelock',
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
				internalType: 'address',
				name: 'account',
				type: 'address',
			},
		],
		name: 'NotCuratorNorGuardianRole',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'account',
				type: 'address',
			},
		],
		name: 'NotCuratorRole',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'account',
				type: 'address',
			},
		],
		name: 'NotGuardianRole',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'account',
				type: 'address',
			},
		],
		name: 'NotModuleRole',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'account',
				type: 'address',
			},
		],
		name: 'NotValidModuleRole',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'minimum',
				type: 'uint256',
			},
		],
		name: 'ProposalFeeToLow',
		type: 'error',
	},
	{
		inputs: [],
		name: 'TimelockNotElapsed',
		type: 'error',
	},
] as const;
