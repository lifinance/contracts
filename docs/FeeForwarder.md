# FeeForwarder

## Description

Periphery contract that forwards various fee amounts directly to their destination wallets. This contract is highly gas-optimized and designed to be called by the LiFiDiamond after fees have been calculated for a swap or bridge execution.

If called by the LiFiDiamond, it's important that the diamond properly handles the remaining funds returned by the FeeForwarder, otherwise funds will remain in the diamond contract and could get stolen.

## Gas Optimizations

The contract implements several gas optimizations to minimize transaction costs:

- **No Length Validation**: Empty distribution arrays are allowed and will not revert (saves ~2,000-3,000 gas)
- **No Balance/Approval Checks**: The contract relies on natural failures when insufficient balance or approvals exist (saves ~2,000-3,000 gas)
- **No Zero Amount Validation**: Zero amounts are allowed and will succeed but transfer nothing (saves ~1,000-2,000 gas)
- **Single Loop for Native Fees**: Uses one optimized loop instead of separate validation and transfer loops (saves ~5,000-10,000 gas)
- **Unchecked Loop Increments**: Loop counters use `unchecked` arithmetic for gas efficiency

## How To Use

The contract supports ERC20 and native assets with two dedicated functions.

### Forwarding ERC20 Fees

```solidity
/// @notice Forwards ERC20 token fees from the caller to the specified recipients
/// @param token address of the token being forwarded
/// @param distributions array of fee distributions containing recipients and amounts
function forwardERC20Fees(
    address token,
    FeeDistribution[] calldata distributions
)
```

**Important Notes:**

- The caller must have approved this contract to spend the tokens before calling this function
- Native token addresses (address(0)) will cause the transaction to revert naturally
- Empty arrays will succeed and emit the FeesForwarded event
- Zero amounts will succeed but transfer nothing

### Forwarding Native Fees

```solidity
/// @notice Forwards native token fees to the specified recipients
/// @param distributions array of fee distributions containing recipients and amounts
function forwardNativeFees(
    FeeDistribution[] calldata distributions
) external payable
```

**Important Notes:**

- Provide at least the sum of all fee amounts via `msg.value`
- Any excess value is automatically returned to the caller
- Empty arrays will succeed, emit the FeesForwarded event, and refund all sent value
- Zero amounts will succeed but transfer nothing
- Transaction will revert if insufficient funds are provided

## Data Structures

### FeeDistribution Struct

```solidity
struct FeeDistribution {
  address recipient; // 20 bytes - The address that will receive the fee amount
  uint256 amount; // 32 bytes - The amount of tokens to distribute to the recipient
}
```

## Events

### FeesForwarded

```solidity
event FeesForwarded(address indexed token, FeeDistribution[] distributions);
```

- **token**: The address of the token that was forwarded (address(0) for native tokens)
- **distributions**: Array of fee distributions that were processed

**Note**: This event is always emitted, even for empty arrays, as it's outside the distribution loop.

## Error Handling

The contract uses minimal error checking for gas optimization:

- **InvalidConfig**: Thrown when constructor receives zero address as owner
- **InvalidReceiver**: Thrown when distribution recipient is zero address (via LibAsset)
- **Natural Failures**: Insufficient balance, approvals, or native value will cause natural reverts

## Security Considerations

- **Owner Recovery**: The contract inherits from `WithdrawablePeriphery`, enabling the owner to recover stray funds
- **No Fund Accumulation**: The contract is designed to not hold any funds and does not collect dust
- **Automatic Refunds**: All excess native tokens are automatically returned to the caller
- **Zero Address Protection**: Zero recipient addresses are validated and will revert

## Gas Usage Estimates

| Operation                        | Gas Range      | Notes                          |
| -------------------------------- | -------------- | ------------------------------ |
| ERC20 Transfer (1 distribution)  | ~22,682-57,640 | Depends on token complexity    |
| ERC20 Transfer (multiple)        | ~86,458        | For large distributions        |
| Native Transfer (1 distribution) | ~22,211-30,894 | Depends on amount              |
| Native Transfer (multiple)       | ~49,563-61,328 | For multiple distributions     |
| Empty Arrays                     | ~15,509-21,514 | Events emitted, no transfers   |
| Zero Amounts                     | ~25,762-25,903 | Succeeds but transfers nothing |
