# ReceiverAcrossV3

## Description

Periphery contract used for arbitrary cross-chain destination calls via AcrossV3

## How To Use

The contract has one method which will (and can only) be called through the AcrossV3 Spokepool contract to execute arbitrary destination calldata:

```solidity
    /// @notice Completes an AcrossV3 cross-chain transaction on the receiving chain
    /// @dev Token transfer and message execution will happen in one atomic transaction
    /// @dev This function can only be called the Across SpokePool on this network
    /// @param tokenSent The address of the token that was received
    /// @param amount The amount of tokens received
    /// @param * - unused(relayer) The address of the relayer who is executing this message
    /// @param message The composed message payload in bytes
    function handleV3AcrossMessage(
        address tokenSent,
        uint256 amount,
        address,
        bytes memory message
    )
```

Furthermore there is one (admin) method that allows withdrawals of stuck tokens by LI.FI administrators:

```solidity
/// @notice Send remaining token to receiver
/// @param assetId token received from the other chain
/// @param receiver address that will receive tokens in the end
/// @param amount amount of token
function pullToken(
    address assetId,
    address payable receiver,
    uint256 amount
)
```
