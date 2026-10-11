import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-verify';
import '@nomicfoundation/hardhat-toolbox';
import '@nomicfoundation/hardhat-network-helpers';
import '@nomicfoundation/hardhat-ignition-ethers';
import 'hardhat-deploy';
import 'hardhat-abi-exporter';
import 'hardhat-contract-sizer';
import { HardhatUserConfig } from 'hardhat/config';
import { Wallet } from 'ethers';

import dotenv from 'dotenv';
dotenv.config();

// ---------------------------------------------------------------------------------------

// const index = process.env.DEPLOYER_SEED_INDEX;
// const start = index && index?.length > 0 ? parseInt(index) : 0;

// const seed = process.env.DEPLOYER_SEED ?? process.env.DEPLOYER_ACCOUNT_SEED;
// if (!seed) throw new Error('Failed to import the seed string from .env');
// const deployer = getChildFromSeed(seed, start);

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) throw new Error('Missing PRIVATE_KEY in .env');
const deployer = new Wallet(privateKey);

console.log('### Deployer Wallet ###');
console.log(deployer.address, `index: `, (deployer as any).index ?? 0);

const alchemy = process.env.ALCHEMY_RPC_KEY;
if (alchemy?.length == 0 || !alchemy) console.log('WARN: No Alchemy Key found in .env');

const etherscan = process.env.ETHERSCAN_API;
if (etherscan?.length == 0 || !etherscan) console.log('WARN: No Etherscan Key found in .env');

// ---------------------------------------------------------------------------------------

const config: HardhatUserConfig = {
	solidity: {
		version: '0.8.20',
		settings: {
			optimizer: {
				enabled: true,
				runs: 200,
			},
		},
	},
	networks: {
		mainnet: {
			url: `https://eth-mainnet.g.alchemy.com/v2/${alchemy}`,
			chainId: 1,
			gas: 'auto',
			gasPrice: 'auto',
			gasMultiplier: 0.5,
			accounts: [deployer.privateKey],
			timeout: 50_000,
		},
		hardhat: {
			forking: {
				url: `https://eth-mainnet.g.alchemy.com/v2/${alchemy}`,
				blockNumber: 24244916,
			},
			gas: 'auto',
			gasPrice: 'auto',
			gasMultiplier: 2,
		},
		arbitrum: {
			url: `https://arb-mainnet.g.alchemy.com/v2/${alchemy}`,
			chainId: 42161,
			gas: 'auto',
			gasPrice: 'auto',
			accounts: [deployer.privateKey],
			timeout: 50_000,
		},
		base: {
			url: `https://base-mainnet.g.alchemy.com/v2/${alchemy}`,
			chainId: 8453,
			gas: 'auto',
			gasPrice: 'auto',
			accounts: [deployer.privateKey],
			timeout: 50_000,
		},
		optimism: {
			url: `https://opt-mainnet.g.alchemy.com/v2/${alchemy}`,
			chainId: 10,
			gas: 'auto',
			gasPrice: 'auto',
			accounts: [deployer.privateKey],
			timeout: 50_000,
		},
		polygon: {
			url: `https://polygon-mainnet.g.alchemy.com/v2/${alchemy}`,
			chainId: 137,
			gas: 'auto',
			gasPrice: 'auto',
			accounts: [deployer.privateKey],
			timeout: 50_000,
		},
	},
	// Etherscan v2: one API key for all chains, hardhat-verify adds the chainid itself
	etherscan: {
		apiKey: etherscan ?? '',
	},
	// Kept enabled. hardhat-verify 2.1.3 (last Hardhat 2 release) still calls Sourcify API v1, which was removed,
	// so this reports a harmless 404 on verify. Etherscan is unaffected. Needs Hardhat 3 / hardhat-verify 3 to work again.
	sourcify: {
		enabled: true,
	},
	namedAccounts: {
		deployer: {
			default: 0,
		},
	},
	paths: {
		sources: './contracts',
		tests: './test',
		cache: './cache',
		artifacts: './artifacts',
	},
	contractSizer: {
		alphaSort: false,
		runOnCompile: false,
		disambiguatePaths: false,
	},
	gasReporter: {
		enabled: true,
		currency: 'USD',
	},
	abiExporter: [
		{
			path: './abi',
			clear: false,
			runOnCompile: true,
			flat: false,
			spacing: 4,
			pretty: false,
		},
		{
			path: './abi/signature',
			clear: false,
			runOnCompile: true,
			flat: false,
			spacing: 4,
			pretty: true,
		},
	],
	mocha: {
		timeout: 120000,
	},
	typechain: {
		outDir: 'typechain',
		target: 'ethers-v6',
	},
};

export default config;
