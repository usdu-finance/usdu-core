export const IModuleExpenseEventsV1_ABI = [
	{
		anonymous: false,
		inputs: [
			{ indexed: true, internalType: 'address', name: 'token', type: 'address' },
			{ indexed: true, internalType: 'address', name: 'to', type: 'address' },
			{ indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
			{ indexed: false, internalType: 'uint256', name: 'totalExpense', type: 'uint256' },
			{ indexed: false, internalType: 'uint256', name: 'totalFunds', type: 'uint256' },
		],
		name: 'Expense',
		type: 'event',
	},
] as const;
