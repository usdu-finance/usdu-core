# USDU Finance - Core Smart Contracts

Core smart contract implementation for USDU Finance, a stablecoin protocol built on Ethereum. This repository contains the essential contracts for the USDU stablecoin, yield-generating vault adapters, and reward distribution system.

## Overview

**Key Components:**

-   **USDU Stablecoin**: ERC20 stablecoin with role-based governance
-   **Vault Adapters**: TermMax, Morpho & Curve integrations for borrow & lending market and deep liquidity
-   **Reward System**: Token distribution and staking rewards
-   **TermMax Integration**: Advanced yield optimization strategies

## Project Structure

```
contracts/
├── stablecoin/         # USDU stablecoin core implementation
├── vault/              # Vault adapters for yield generation
├── morpho/             # Morpho protocol integration
├── curve/              # Curve protocol integration
├── reward/             # Reward distribution system
└── test/               # Test contracts and utilities
```

**Supported Networks:**

-   **Mainnet** (primary): Full protocol deployment with all contracts
-   **L2s** (in discussion): Polygon, Arbitrum, Optimism, Base, Avalanche, Gnosis, Sonic

> See `exports/address.types.ts` for complete chain configurations and `exports/address.config.ts` for deployed addresses.

## Design Notes

-   **No permanent modules**: every module set via `Stablecoin.setModule` / `setModulePublic` carries an `expiredAt` timestamp. There is no "forever" sentinel (e.g. `type(uint256).max`) — future deployments should bound `expiredAt` to a `maxLifespan` (e.g. 100yrs), which is effectively permanent in practice but keeps modules re-affirmable.

## Quick Start

```bash
# Setup
yarn install
cp .env.example .env  # Configure your environment

# Development
yarn compile          # Compile contracts
yarn test            # Run tests
yarn coverage        # Test coverage

# Deployment
yarn deploy ignition/modules/StablecoinModule.ts --network mainnet --verify

# Package
yarn npm:build       # Build for npm
yarn npm:publish     # Publish package
```

## Development Workflow

### Environment Setup

Create `.env` file (see `.env.example`):

```bash
DEPLOYER_SEED="your mnemonic here"
DEPLOYER_SEED_INDEX=0
ALCHEMY_RPC_KEY=your_api_key
ETHERSCAN_API=your_api_key
```

### Testing & Building

```bash
yarn test                    # All tests
yarn test test/Stablecoin.ts # Specific test
yarn coverage               # Coverage report
```

### Deployment

Create deployment modules in `/ignition/modules/` and parameter files in `/ignition/params/`:

```bash
yarn deploy ignition/modules/StablecoinModule.ts --network mainnet --verify --deployment-id USDU01
```

This compiles, deploys, and verifies contracts on Etherscan/Sourcify. Artifacts are saved to `/ignition/deployments/`.

**Manual Verification:**

```bash
npx hardhat verify --network mainnet --constructor-args ./ignition/constructor-args/$FILE.js $ADDRESS
npx hardhat ignition verify $DEPLOYMENT --include-unrelated-contracts
```

## NPM Package

The package exports TypeScript ABIs and address configurations:

**ABIs:** `exports/abis/` - Contract ABIs as TypeScript constants  
**Addresses:** `exports/address.config.ts` - Deployed contract addresses by chain  
**Types:** `exports/address.types.ts` - Chain configurations and type definitions

```typescript
import { ADDRESS, StablecoinABI, MorphoAdapterV1ABI } from '@usdu-finance/usdu-core';

// Get mainnet addresses
const { usduStable, usduMorphoAdapterV1_2 } = ADDRESS[1];

// Use ABIs with contract instances
const stablecoin = new Contract(usduStable, StablecoinABI, provider);
```

### Package Publishing

1. **Update version** in `package.json` (semantic versioning)
2. **Build package:** `yarn npm:build` (uses tsup config)
3. **Publish:** `yarn npm:publish` (requires `npm login`)

**Next.js Integration:**

```js
// next.config.js
module.exports = {
	transpilePackages: ['@usdu-finance/usdu-core'],
};
```
