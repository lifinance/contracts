# OutputValidator

## Overview

The `OutputValidator` contract is a periphery contract that validates swap output amounts and handles positive slippage by transferring excess tokens to a designated validation wallet. It is designed to be called by the Diamond contract after a swap operation to ensure that any excess output tokens are properly managed.

## Key Features

- **Output Validation**: Assumes actual output amount exceeds expected amount for gas efficiency
- **Excess Token Management**: Automatically transfers excess tokens to a validation wallet
- **Dual Token Support**: Handles both native (ETH) and ERC20 tokens
- **Gas Optimized**: Eliminates conditional checks and assumes positive slippage scenarios (~200-300 gas saved per call)
- **Comprehensive Test Coverage**: 100% line coverage with 19 test cases

## Contract Logic

### Native Token Flow

1. The calling contract (Diamond) sends native tokens as `msg.value` to the OutputValidator
2. The contract always returns the expected amount to the calling contract using `LibAsset.transferAsset`
3. **Assumes positive slippage**: Always transfers excess to validation wallet (handles zero excess by transferring 0 tokens)

### ERC20 Token Flow

1. The calling contract (Diamond) must have sufficient ERC20 token balance
2. The OutputValidator checks the Diamond's ERC20 balance using `ERC20(tokenAddress).balanceOf(msg.sender)`
3. **Assumes positive slippage**: Always transfers excess to validation wallet (handles zero excess by transferring 0 tokens)
4. The Diamond retains the expected amount

> **Gas Optimization**: The contract assumes `actualAmount > expectedAmount` and eliminates conditional checks. If this assumption is violated, the transaction reverts immediately on arithmetic underflow. Zero excess cases are handled gracefully by transferring 0 tokens.

**Note**: The contract successfully handles edge cases where `actualAmount == expectedAmount` by transferring 0 excess tokens, rather than reverting.

## Functions

### `validateOutput`

```solidity
function validateOutput(
    address tokenAddress,
    uint256 expectedAmount,
    address validationWalletAddress
) external payable
```

**Parameters:**

- `tokenAddress`: The address of the token to validate (use `LibAsset.NULL_ADDRESS` for native tokens)
- `expectedAmount`: The expected amount of tokens
- `validationWalletAddress`: The address to send excess tokens to

**Behavior:**

- For native tokens: Receives tokens as `msg.value`, returns expected amount to caller, transfers excess to validation wallet
- For ERC20 tokens: Checks caller's balance, transfers excess to validation wallet using `transferFrom`

## Errors

The contract does not define custom errors. Error handling is delegated to the underlying libraries:

- **Native token errors**: Handled by `LibAsset.transferAsset()`
- **ERC20 token errors**: Handled by `SafeTransferLib.safeTransferFrom()`
- **Input validation**: Handled by `LibAsset` library for null address checks

## Integration

### Example Usage

```solidity
// For native tokens
outputValidator.validateOutput{value: actualAmount}(
    LibAsset.NULL_ADDRESS,
    expectedAmount,
    validationWallet
);

// For ERC20 tokens
// First approve the OutputValidator to spend tokens
token.approve(address(outputValidator), actualAmount);
outputValidator.validateOutput(
    address(token),
    expectedAmount,
    validationWallet
);
```

## Security Considerations

- The contract inherits from `TransferrableOwnership` for secure ownership management
- Uses `SafeTransferLib` for safe ERC20 operations
- Custom errors provide gas-efficient error handling
- Input validation leverages `LibAsset.transferAsset` for null address checks

## Test Coverage

The contract includes comprehensive test coverage with **100% line coverage** including:

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

> **Note**: Coverage tools may mark comment lines as uncovered, but all executable code lines achieve 100% coverage.

## Deployment

The contract is deployed using the standard deployment script pattern and extracts the owner address from the global configuration file. The contract is automatically included in periphery contract deployments and is configured in `script/deploy/resources/deployRequirements.json`.

### **Deployment Scripts**

- **Standard**: `script/deploy/Periphery/DeployOutputValidator.s.sol`
- **zkSync**: `script/deploy/zksync/DeployOutputValidator.zksync.s.sol`

Both scripts follow the established deployment patterns and integrate with the CREATE3Factory for predictable contract addresses.
