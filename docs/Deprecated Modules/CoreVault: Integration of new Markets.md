# CoreVault: Integration of WETH

## Contracts

MetaMorphoV1_1: `0xcE22b5Fb17ccbc0C5d87DC2e0dF47DD71E3AdC0a`
PublicAllocator: `0xfd32fA2ca22c76dD6E550706Ad913FC6CE91c75D`

## Actions

```
submitCap
MetaMorphoV1_1
0xcE22…dC0a

acceptCap
MetaMorphoV1_1
0xcE22…dC0a

setSupplyQueue
MetaMorphoV1_1
0xcE22…dC0a

updateWithdrawQueue
MetaMorphoV1_1
0xcE22…dC0a

setFlowCaps
PublicAllocator
0xfd32…c75D

reallocateTo
PublicAllocator
0xfd32…c75D
```

## Details

### submitCap

target: `0xcE22b5Fb17ccbc0C5d87DC2e0dF47DD71E3AdC0a`
function: `submitCap`
params:

```
# marketParams

loanToken

0xdde3eC717f220Fc6A29D6a4Be73F91DA5b718e55
collateralToken

0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
oracle

0x0BB7EdDF8cD63f52676f1B527c6Cf5BE57604d92
irm

0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC
lltv

860000000000000000


# newSupplyCap

10000000000000000000000000
```

### acceptCap

target: `0xcE22b5Fb17ccbc0C5d87DC2e0dF47DD71E3AdC0a`
function: `submitCap`
params:

```
# marketParams

loanToken

0xdde3eC717f220Fc6A29D6a4Be73F91DA5b718e55
collateralToken

0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
oracle

0x0BB7EdDF8cD63f52676f1B527c6Cf5BE57604d92
irm

0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC
lltv

860000000000000000
```

### setSupplyQueue

target: `0xcE22b5Fb17ccbc0C5d87DC2e0dF47DD71E3AdC0a`
function: `setSupplyQueue`
params:

```
# newSupplyQueue

0x60f855f6b8c6919c2a4f3ab5f367fc923e3172e6dc8f4e8b6c448eb2d43421a1
0xa6b5b5cc24a40900156a503afc6c898118b6d37ae545c2c144326fb95ac68e7a
0x0f2c33f9074109b75b88617534e6ac6dfa8ebf97270c716782221a27cbf0d880
```

### updateWithdrawQueue

target: `0xcE22b5Fb17ccbc0C5d87DC2e0dF47DD71E3AdC0a`
function: `updateWithdrawQueue`
params:

```
# indexes

2
1
0
```

### setFlowCaps

target: `0xfd32fA2ca22c76dD6E550706Ad913FC6CE91c75D`
function: `setFlowCaps`
params:

```
# vault

0xcE22b5Fb17ccbc0C5d87DC2e0dF47DD71E3AdC0a

# config

## id
0xa6b5b5cc24a40900156a503afc6c898118b6d37ae545c2c144326fb95ac68e7a

## caps

maxIn
100000000000000000000000

maxOut
100000000000000000000000
```

### reallocateTo

target: `0xfd32fA2ca22c76dD6E550706Ad913FC6CE91c75D`
function: `reallocateTo`
params:

```
vault

0xcE22b5Fb17ccbc0C5d87DC2e0dF47DD71E3AdC0a
withdrawals

marketParams

loanToken

0xdde3eC717f220Fc6A29D6a4Be73F91DA5b718e55
collateralToken

0x0000000000000000000000000000000000000000
oracle

0x0000000000000000000000000000000000000000
irm

0x0000000000000000000000000000000000000000
lltv

0
amount

1000000000000000000000
supplyMarketParams

loanToken

0xdde3eC717f220Fc6A29D6a4Be73F91DA5b718e55
collateralToken

0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
oracle

0x0BB7EdDF8cD63f52676f1B527c6Cf5BE57604d92
irm

0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC
lltv

860000000000000000
```
