export const ModuleExpenseV1_ABI = [
	{
		inputs: [
			{ internalType: 'uint256', name: 'requested', type: 'uint256' },
			{ internalType: 'uint256', name: 'cap', type: 'uint256' },
		],
		name: 'FundsCapExceeded',
		type: 'error',
	},
	{
		anonymous: false,
		inputs: [
			{ indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
			{ indexed: false, internalType: 'uint256', name: 'totalExpense', type: 'uint256' },
			{ indexed: false, internalType: 'uint256', name: 'totalFunds', type: 'uint256' },
		],
		name: 'Expense',
		type: 'event',
	},
	{
		inputs: [],
		name: 'fundsCap',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
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
	{
		inputs: [],
		name: 'totalExpense',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'totalFunds',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
		stateMutability: 'view',
		type: 'function',
	},
] as const;
