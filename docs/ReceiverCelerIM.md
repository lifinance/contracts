# CelerIMReceiver

## Description

Periphery contract used for arbitrary cross-chain execution using CBridge / CelerIM

## How To Use

The contract is used to receive funds and parse payloads sent cross-chain using Celer Bridge.

The following external methods are available:

The contract has one utility method for updating the Axelar gateway

```solidity
/// @notice sets the CBridge MessageBus address
/// @param _gateway the MessageBus address
function setCBridgeMessageBus(address _messageBusAddress)
```
