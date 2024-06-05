# ReceiverStargateV2

## Description

Periphery contract used for arbitrary cross-chain destination calls via StargateV2

## How To Use

The contract has one method which will be called through the LayerZero endpoint:


```solidity
  /// @notice Completes a stargateV2 cross-chain transaction on the receiving chain
  /// @dev This function is called by Stargate Router via LayerZero endpoint (sendCompose(...) function)
  /// @param * (unused) The address initiating the composition, typically the OApp where the lzReceive was called
  /// @param * (unused) The unique identifier for the corresponding LayerZero src/dst tx
  /// @param _message The composed message payload in bytes. NOT necessarily the same payload passed via lzReceive
  /// @param * (unused) The address of the executor for the composed message
  /// @param * (unused) Additional arbitrary data in bytes passed by the entity who executes the lzCompose
    function lzCompose(
    bytes32 _transferId,
    uint256 _amount,
    address _asset,
    address,
    uint32,
    bytes memory _callData
)
```

Furthermore there is one (admin) method that allows withdrawals of stuck tokens:

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
