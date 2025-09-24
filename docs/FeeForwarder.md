# FeeForwarder

## Description

Periphery contract that forwards various fee amounts directly to their destination wallets.

## How To Use

The contract is designed to be called by the LiFiDiamond after fees have been calculated for a swap or bridge execution. It supports ERC20 and native assets with two dedicated functions.

Forwarding ERC20 fees

```solidity
/// @notice Forwards ERC20 token fees from the caller to the specified recipients
/// @param token address of the token being forwarded
/// @param distributions array of fee distributions containing recipients and amounts
function forwardERC20Fees(
    address token,
    FeeDistribution[] calldata distributions
)
```

Forwarding native fees

```solidity
/// @notice Forwards native token fees to the specified recipients
/// @param distributions array of fee distributions containing recipients and amounts
function forwardNativeFees(
    FeeDistribution[] calldata distributions
) external payable
```

Both functions expect an array of `FeeDistribution` structs (`address recipient; uint256 amount;`). For native forwards provide at least the sum of all fee amounts via `msg.value`. Any excess value is returned to the caller.

Each call emits a `FeesForwarded` event that includes the token identifier (use `address(0)` for native assets) and the complete distribution array.

The contract inherits from `WithdrawablePeriphery`, enabling the owner to recover stray funds.
