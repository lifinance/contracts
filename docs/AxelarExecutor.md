# Executor

## Description

Periphery contract used for aribitrary cross-chain execution using Axelar

## How To Use

The contract is used to parse payloads sent cross-chain using the Axelar cross-chain execution platform.

The following external methods are available:

The contract has one utility method for updating the Axelar gateway

```solidity
/// @notice set the Axelar gateway
/// @param _gateway the Axelar gateway address
function setAxelarGateway(address _gateway)
```
