# OutputValidator

## Overview

The `OutputValidator` contract is a periphery contract that validates swap output amounts and transfers excess tokens to a designated validation wallet. It is designed to be called by the Diamond contract after a swap operation to ensure that any excess output tokens are properly distributed.

## Key Features

- **Excess Distribution Management**: Intelligently distributes excess tokens to validation wallet
- **Dual Token Support**: Handles both native (ETH) and ERC20 tokens with separate functions
- **No Ownership**: Stateless design without ownership requirements
- **Gas Optimized**: Minimal validation for maximum efficiency

## Contract Logic

### Native Token Flow

1. The calling contract (Diamond) sends a portion of native tokens as `msg.value` for excess handling
2. **Calculates excess**: `excessAmount = (contract_balance + msg.value) - expectedAmount`
3. **Smart distribution**:
   - If `excessAmount >= msg.value`: All `msg.value` goes to validation wallet (contract balance covers expected amount)
   - If `excessAmount < msg.value`: Sends `excessAmount` to validation wallet, returns `msg.value - excessAmount` to sender
4. **User receives expected amount** through the normal swap flow, not from this contract

### ERC20 Token Flow

1. The calling contract (Diamond) must have sufficient ERC20 token balance and approve this contract
2. **Calculates excess**: `excessAmount = ERC20(tokenAddress).balanceOf(msg.sender) - expectedAmount`
3. **Transfer excess**: If `excessAmount > 0`, transfers excess tokens to validation wallet via `transferFrom`
4. **Safety checks**: Validates wallet address and handles zero excess gracefully

> **Design Philosophy**: The contract handles excess distribution only. Users receive their `expectedAmount` through the primary swap mechanism, while this contract ensures proper excess management without holding funds permanently.

**Note**: The contract reverts on arithmetic underflow if actual amounts are less than expected, providing fail-safe behavior.

## Functions

### `validateNativeOutput`

```solidity
function validateNativeOutput(
    uint256 expectedAmount,
    address validationWalletAddress
) external payable
```

**Parameters:**

- `expectedAmount`: The expected amount of native tokens (minAmountOut)
- `validationWalletAddress`: The address to send excess tokens to

**Behavior:**

- Calculates total output as `contract_balance + msg.value`
- Intelligently distributes excess between validation wallet and sender
- Designed for scenarios where `msg.value` represents a portion sent for excess handling

### `validateERC20Output`

```solidity
function validateERC20Output(
    address tokenAddress,
    uint256 expectedAmount,
    address validationWalletAddress
) external
```

**Parameters:**

- `tokenAddress`: The address of the ERC20 token to validate
- `expectedAmount`: The expected amount of tokens (minAmountOut)
- `validationWalletAddress`: The address to send excess tokens to

**Behavior:**

- Checks caller's token balance and calculates excess
- Transfers excess to validation wallet if `excessAmount > 0`
- Validates wallet address and requires sufficient allowance

## Errors

The contract does not define custom errors. Error handling is delegated to the underlying libraries:

- **Native token errors**: Handled by `LibAsset.transferAsset()`
- **ERC20 token errors**: Handled by `SafeTransferLib.safeTransferFrom()`
- **Input validation**: Handled by `LibAsset` library for null address checks

## Integration

### Example Usage

```solidity
// For native tokens - send portion of output for excess handling
outputValidator.validateNativeOutput{value: portionForExcess}(
    expectedAmount,
    validationWallet
);

// For ERC20 tokens
// First approve the OutputValidator to spend excess tokens
token.approve(address(outputValidator), excessAmount);
outputValidator.validateERC20Output(
    address(token),
    expectedAmount,
    validationWallet
);
```

## Security Considerations

- **Stateless Design**: No ownership or state storage reduces attack surface
- **Safe Transfers**: Uses `SafeTransferLib` for safe ERC20 operations and `LibAsset` for native transfers
- **Input Validation**: ERC20 function validates wallet addresses; native transfers rely on `LibAsset` validation
- **Fail-Safe Behavior**: Reverts on arithmetic underflow when actual < expected amounts
- **No Fund Retention**: Contract never retains funds permanently, minimizing risk

## Test Coverage

The contract includes comprehensive test coverage including:

### **Core Functionality Tests**

- Native token validation with excess (positive slippage scenarios)
- ERC20 token validation with excess (positive slippage scenarios)
- Edge cases (zero expected amount, insufficient allowance)

### **Integration Tests**

- Complete DEX swap + OutputValidator + Bridge flows
- ERC20 → ERC20 swap with positive slippage
- ERC20 → Native swap with positive slippage
- Native → ERC20 swap with positive slippage

### **Negative Test Cases**

- Insufficient allowance scenarios
- Native transfer failures to invalid addresses
- Zero value with non-zero expected amount
- **No excess scenarios** (contract handles gracefully by transferring 0 tokens)

### **Test Statistics**

- **19 test cases** covering all code paths
- **All branches covered** including edge cases
- **Realistic scenarios** using MockDEX and Diamond integration

## Deployment

The contract is deployed using the standard deployment script pattern with no constructor parameters. The contract is automatically included in periphery contract deployments and is configured in `script/deploy/resources/deployRequirements.json`.

### **Deployment Scripts**

- **Standard**: `script/deploy/facets/DeployOutputValidator.s.sol`
- **zkSync**: `script/deploy/zksync/DeployOutputValidator.zksync.s.sol`

Both scripts follow the established deployment patterns and integrate with the CREATE3Factory for predictable contract addresses. No configuration parameters are required due to the stateless design.
