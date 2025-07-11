# RelayerCelerIM

## Description

Periphery contract used for arbitrary cross-chain execution using CelerIM framework

## How To Use

The contract is used to receive and forward funds and as well as receive/parse payloads sent cross-chain using CelerIM.

The following external methods are available:

```solidity
/// @notice Called by MessageBus to execute a message with an associated token transfer. The Receiver is guaranteed to have received the right amount of tokens before this function is called.
/// @dev can only be called by the cBridge message bus contract on the respective chain
/// @param * (unused) The address of the source app contract
/// @param _token The address of the token that comes out of the bridge
/// @param _amount The amount of tokens received at this contract through the cross-chain bridge.
/// @param * (unused)  The source chain ID where the transfer is originated from
/// @param _message Arbitrary message bytes originated from and encoded by the source app contract
/// @param * (unused)  Address who called the MessageBus execution function
function executeMessageWithTransfer(
    address,
    address _token,
    uint256 _amount,
    uint64,
    bytes calldata _message,
    address
)
```

```solidity
/// @notice Called by MessageBus to process refund of the original transfer from this contract. The contract is guaranteed to have received the refund before this function is called.
/// @dev can only be called by the cBridge message bus contract on the respective chain
/// @param _token The token address of the original transfer
/// @param _amount The amount of the original transfer
/// @param _message The same message associated with the original transfer
/// @param * (unused) Address who called the MessageBus execution function
function executeMessageWithTransferRefund(
    address _token,
    uint256 _amount,
    bytes calldata _message,
    address
)
```

```solidity
/// @notice Forwards a call to transfer tokens to cBridge (sent via this contract to ensure that potential refunds are sent here)
/// @dev can only be called by the LI.FI diamond contract on the respective chain
/// @param _bridgeData the core information needed for bridging
/// @param _celerIMData data specific to CelerIM
function sendTokenTransfer(BridgeData memory _bridgeData, CelerIMData calldata _celerIMData)
    external
    payable
    onlyDiamond
    returns (bytes32 transferId, address bridgeAddress)
```
