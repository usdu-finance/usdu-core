export const IForeignSwapperV1_ABI = [
	{
		inputs: [],
		name: 'BadRoute',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'got',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'required',
				type: 'uint256',
			},
		],
		name: 'InsufficientOutput',
		type: 'error',
	},
	{
		inputs: [],
		name: 'NothingToSwap',
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
		name: 'RouteNotEnabled',
		type: 'error',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
		],
		name: 'RouteDisabled',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'tokenOut',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'minRate',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'maxAmount',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'minAmount',
				type: 'uint256',
			},
		],
		name: 'RouteSet',
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
				indexed: true,
				internalType: 'address',
				name: 'dao',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'address',
				name: 'tokenOut',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'spent',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'received',
				type: 'uint256',
			},
		],
		name: 'Swapped',
		type: 'event',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
		],
		name: 'disableRoute',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
		],
		name: 'getRoute',
		outputs: [
			{
				components: [
					{
						internalType: 'bool',
						name: 'enabled',
						type: 'bool',
					},
					{
						internalType: 'address',
						name: 'tokenOut',
						type: 'address',
					},
					{
						internalType: 'uint256',
						name: 'minRate',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'maxAmount',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'minAmount',
						type: 'uint256',
					},
					{
						components: [
							{
								internalType: 'address',
								name: 'target',
								type: 'address',
							},
							{
								internalType: 'address',
								name: 'tokenIn',
								type: 'address',
							},
							{
								internalType: 'address',
								name: 'tokenOut',
								type: 'address',
							},
							{
								internalType: 'bool',
								name: 'patchAmount',
								type: 'bool',
							},
							{
								internalType: 'uint16',
								name: 'amountOffset',
								type: 'uint16',
							},
							{
								internalType: 'bytes',
								name: 'data',
								type: 'bytes',
							},
						],
						internalType: 'struct IForeignSwapperV1.Step[]',
						name: 'steps',
						type: 'tuple[]',
					},
				],
				internalType: 'struct IForeignSwapperV1.Route',
				name: '',
				type: 'tuple',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
			{
				components: [
					{
						internalType: 'bool',
						name: 'enabled',
						type: 'bool',
					},
					{
						internalType: 'address',
						name: 'tokenOut',
						type: 'address',
					},
					{
						internalType: 'uint256',
						name: 'minRate',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'maxAmount',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'minAmount',
						type: 'uint256',
					},
					{
						components: [
							{
								internalType: 'address',
								name: 'target',
								type: 'address',
							},
							{
								internalType: 'address',
								name: 'tokenIn',
								type: 'address',
							},
							{
								internalType: 'address',
								name: 'tokenOut',
								type: 'address',
							},
							{
								internalType: 'bool',
								name: 'patchAmount',
								type: 'bool',
							},
							{
								internalType: 'uint16',
								name: 'amountOffset',
								type: 'uint16',
							},
							{
								internalType: 'bytes',
								name: 'data',
								type: 'bytes',
							},
						],
						internalType: 'struct IForeignSwapperV1.Step[]',
						name: 'steps',
						type: 'tuple[]',
					},
				],
				internalType: 'struct IForeignSwapperV1.Route',
				name: 'route',
				type: 'tuple',
			},
		],
		name: 'setRoute',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
		],
		name: 'swap',
		outputs: [
			{
				internalType: 'uint256',
				name: 'spent',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'received',
				type: 'uint256',
			},
		],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
		],
		name: 'swappable',
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
] as const;
