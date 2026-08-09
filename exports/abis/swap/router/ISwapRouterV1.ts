export const ISwapRouterV1_ABI = [
	{
		inputs: [
			{ internalType: 'contract ISwapBridgeV1[]', name: 'modules', type: 'address[]' },
			{ internalType: 'address[]', name: 'targets', type: 'address[]' },
			{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' },
			{ internalType: 'bool[]', name: 'isSwapIn', type: 'bool[]' },
		],
		name: 'execute',
		outputs: [{ internalType: 'uint256[]', name: 'amountsOut', type: 'uint256[]' }],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'stable',
		outputs: [{ internalType: 'contract IStablecoin', name: '', type: 'address' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'contract ISwapBridgeV1', name: 'module', type: 'address' },
			{ internalType: 'uint256', name: 'amount', type: 'uint256' },
		],
		name: 'swapIn',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'contract ISwapBridgeV1', name: 'module', type: 'address' },
			{ internalType: 'address', name: 'target', type: 'address' },
			{ internalType: 'uint256', name: 'amount', type: 'uint256' },
		],
		name: 'swapInTo',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'contract ISwapBridgeV1', name: 'module', type: 'address' },
			{ internalType: 'uint256', name: 'amount', type: 'uint256' },
		],
		name: 'swapOut',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'contract ISwapBridgeV1', name: 'module', type: 'address' },
			{ internalType: 'address', name: 'target', type: 'address' },
			{ internalType: 'uint256', name: 'amount', type: 'uint256' },
		],
		name: 'swapOutTo',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'contract IERC20', name: 'token', type: 'address' },
			{ internalType: 'address', name: 'to', type: 'address' },
			{ internalType: 'uint256', name: 'amount', type: 'uint256' },
		],
		name: 'sweep',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
] as const;
