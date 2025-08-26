# OutputValidator

## Overview

The `OutputValidator` contract is a periphery contract that validates swap output amounts and transfers excess tokens to a designated validation wallet. It is designed to be called by the Diamond contract after a swap operation to ensure that any excess output tokens are properly distributed. The contract inherits from `WithdrawablePeriphery`, providing token recovery functionality for the contract owner.

**Key Design Philosophy**: This contract is designed to not hold any funds, which is why it's safe to work with full balances. Accidentally stuck funds can easily be recovered using the provided public functions.

## Key Features

- **Excess Distribution Management**: Intelligently distributes excess tokens to validation wallet
- **Dual Token Support**: Handles both native (ETH) and ERC20 tokens with separate functions
- **Owner-based Access Control**: Inherits from WithdrawablePeriphery for secure token management
- **Gas Optimized**: Minimal validation for maximum efficiency (does not validate expected amounts to save gas)
- **Token Recovery**: Owner can withdraw accidentally stuck tokens
- **No Fund Retention**: Contract never retains funds permanently, minimizing risk

## Contract Logic

### Native Token Flow

1. The calling contract (Diamond) forwards some or all native output as `msg.value` for excess handling.
2. **Compute pre-call balance and excess**:
   - `preCallBalance = msg.sender.balance + msg.value` (caller’s balance before invoking this function)
   - `excessAmount = preCallBalance - expectedAmount`
3. **Distribution**:
   - Sends `min(excessAmount, msg.value)` to the validation wallet.
   - Refunds the remainder `msg.value - min(excessAmount, msg.value)` back to the caller.

Integration note: If you intend to forward all excess, ensure `msg.value >= excessAmount`; otherwise any residual excess stays with the caller by design.

**Note**: This function requires `msg.value` to work as expected, otherwise it cannot determine how much excess exists.
### ERC20 Token Flow

1. The calling contract (Diamond) must have sufficient ERC20 token balance and approve this contract
2. **Calculates excess**: `excessAmount = ERC20(tokenAddress).balanceOf(msg.sender) - expectedAmount`
3. **Transfer excess**: If `excessAmount > 0`, transfers excess tokens to validation wallet via `transferFrom`
4. **Safety checks**: Validates wallet address and handles zero excess gracefully

> **Design Philosophy**: The contract handles excess distribution only. Users receive their `expectedAmount` through the primary swap mechanism, while this contract ensures proper excess management without holding funds permanently. The contract does not validate expected amounts to save gas, and tokens are never lost - even if amount == 0, all tokens will be forwarded to the validation wallet.

**Note**: The case where `outputAmount < expectedAmount` should not be possible since the diamond ensures that `minAmountOut` is received from a swap and that same value is used as `expectedAmount` for this call.

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

- Calculates pre-call balance as `preCallBalance = msg.sender.balance + msg.value` and excess as `excess = preCallBalance - expectedAmount`
- Distributes `min(excess, msg.value)` to the validation wallet and refunds the remainder to the caller
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

### `withdrawToken` (inherited from WithdrawablePeriphery)

```solidity
function withdrawToken(
    address assetId,
    address payable receiver,
    uint256 amount
) external onlyOwner
```

**Parameters:**

- `assetId`: The address of the token to withdraw (address(0) for native tokens)
- `receiver`: The address to receive the withdrawn tokens
- `amount`: The amount of tokens to withdraw

**Behavior:**

- Allows the contract owner to withdraw accidentally stuck tokens
- Supports both native and ERC20 token withdrawals
- Emits `TokensWithdrawn` event on successful withdrawal

## Errors

The contract inherits errors from WithdrawablePeriphery and defines custom errors:

- **UnAuthorized**: Thrown when non-owner tries to withdraw tokens
- **InvalidCallData**: Thrown when validation wallet address is zero
- **Native token errors**: Handled by `LibAsset.transferAsset()`
- **ERC20 token errors**: Handled by `SafeTransferLib.safeTransferFrom()`

## Events

### `TokensWithdrawn` (inherited from WithdrawablePeriphery)

```solidity
event TokensWithdrawn(
  address assetId,
  address payable receiver,
  uint256 amount
);
```

Emitted when the owner successfully withdraws tokens from the contract.

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

// Owner can withdraw stuck tokens
outputValidator.withdrawToken(
    address(token),
    payable(owner),
    stuckAmount
);
```

## Security Considerations

- **Owner-based Access Control**: Only the contract owner can withdraw stuck tokens
- **Safe Transfers**: Uses `SafeTransferLib` for safe ERC20 operations and `LibAsset` for native transfers
- **Input Validation**: ERC20 function validates wallet addresses; native transfers rely on `LibAsset` validation
- **Fail-Safe Behavior**: Reverts on arithmetic underflow when actual < expected amounts
- **No Fund Retention**: Contract never retains funds permanently, minimizing risk
- **Inheritance Security**: Inherits proven security patterns from WithdrawablePeriphery

## Deployment

The contract is deployed using the standard deployment script pattern with an owner parameter. The contract is automatically included in periphery contract deployments and is configured in `script/deploy/resources/deployRequirements.json`.

### **Deployment Scripts**

- **Standard**: `script/deploy/facets/DeployOutputValidator.s.sol`
- **zkSync**: `script/deploy/zksync/DeployOutputValidator.zksync.s.sol`

Both scripts follow the established deployment patterns and integrate with the CREATE3Factory for predictable contract addresses. The owner parameter is read from the global configuration file (`config/global.json`) using the `refundWallet` address.

### **Constructor Parameters**

- `_owner`: The address that will have access to withdraw stuck tokens (typically the same as refund wallet owner)

### **Configuration**

The contract owner is configured via the global configuration file:

```json
{
  "refundWallet": "0x..."
}
```

This ensures consistent ownership with the refund wallet for token recovery operations.
