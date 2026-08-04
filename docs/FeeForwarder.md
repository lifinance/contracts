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

The native refund is derived from `msg.value` minus the sum of the distributed amounts rather than from the contract's balance. Summing the distributions inside the existing loop costs a measured +166 gas for one distribution, +252 for two and +338 for three — accepted deliberately, see [Security Considerations](#security-considerations).

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
- The unspent part of `msg.value` is automatically returned to the caller
- Empty arrays will succeed, emit the FeesForwarded event, and refund all sent value
- Zero amounts will succeed but transfer nothing
- Transaction will revert if insufficient funds are provided
- A balance already sitting in the contract is never paid out as a refund; only the owner can recover it

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
- **Arithmetic Panic (0x11)**: Thrown by `forwardNativeFees` when the distributions sum to more than `msg.value`, which would otherwise draw on funds the caller did not provide

## Security Considerations

- **Owner Recovery**: The contract inherits from `WithdrawablePeriphery`, enabling the owner to recover stray funds
- **No Fund Accumulation**: The contract is designed to not hold any funds and does not collect dust
- **Automatic Refunds**: The unspent part of `msg.value` is automatically returned to the caller
- **Zero Address Protection**: Zero recipient addresses are validated and will revert
- **Reentrancy**: Native fees are paid out with all gas forwarded, so a recipient can call back into `forwardNativeFees` while the outer call is still running. Re-entry is not blocked; it is made unprofitable. Because each invocation refunds `msg.value` minus its own distributions, a nested call can never be paid from the outer call's undistributed funds or from a stray balance — the checked subtraction reverts instead. The outer call then completes normally, so a malicious recipient cannot use this to grief the surrounding route either. A `nonReentrant` guard would produce the same outcome but costs a measured +7,266 gas per call on this contract (a quarter of a single native distribution), because the repo's guard writes a storage slot and Solidity 0.8.17 has no transient storage.

## Gas Usage Estimates

| Operation                        | Gas Range      | Notes                          |
| -------------------------------- | -------------- | ------------------------------ |
| ERC20 Transfer (1 distribution)  | ~22,682-57,640 | Depends on token complexity    |
| ERC20 Transfer (multiple)        | ~86,458        | For large distributions        |
| Native Transfer (1 distribution) | ~22,211-30,894 | Depends on amount              |
| Native Transfer (multiple)       | ~49,563-61,328 | For multiple distributions     |
| Empty Arrays                     | ~15,509-21,514 | Events emitted, no transfers   |
| Zero Amounts                     | ~25,762-25,903 | Succeeds but transfers nothing |
