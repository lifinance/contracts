# LidoWrapper

## Description

A periphery contract that provides functionality to wrap and unwrap Lido's stETH and wstETH tokens on L2 networks. The contract acts as a wrapper around Lido's stETH contract to facilitate the conversion between stETH and wstETH tokens.

## Key Features

- Wraps stETH into wstETH
- Unwraps wstETH into stETH
- Supports L2 networks (not yet ready for mainnet)
- Inherits from WithdrawablePeriphery for token recovery functionality

## Functions

### wrapStETHToWstETH

```solidity
function wrapStETHToWstETH(uint256 _amount) external returns (uint256 wrappedAmount)
```

Wraps stETH tokens into wstETH tokens.

- Transfers `_amount` stETH from the caller
- Unwraps the stETH via the stETH contract to get wstETH
- Returns the resulting wstETH to the caller

### unwrapWstETHToStETH

```solidity
function unwrapWstETHToStETH(uint256 _amount) external returns (uint256 unwrappedAmount)
```

Unwraps wstETH tokens into stETH tokens.

- Transfers `_amount` wstETH from the caller
- Wraps the wstETH via the stETH contract to get stETH
- Returns the resulting stETH to the caller

## Important Notes

1. The contract is not yet ready for mainnet deployment
2. The naming of wrap/unwrap functions in Lido's L2 contracts is reversed from typical expectations
3. Any stETH or wstETH tokens sent directly to the contract can be irrecoverably swept by MEV bots
4. The contract automatically approves the stETH contract to pull wstETH tokens (max allowance)

## Constructor Parameters

- `_stETHAddress`: Address of the stETH token on L2
- `_wstETHAddress`: Address of the bridged wstETH token on L2
- `_owner`: Address of the contract owner

## Security Considerations

- The contract inherits from WithdrawablePeriphery which provides token recovery functionality
- Direct transfers to the contract are not supported and may result in lost tokens
- The contract is designed to not hold funds between operations
