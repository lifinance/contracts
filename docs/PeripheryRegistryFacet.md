# Periphery Registry Facet

## Description

A simple facet for registering and keeping track of periphery contracts

## How To Use

This contract contract has two simple methods. One for registering a contract address with key
and another for retrieving that address by its key.

Registering

```solidity
/// @notice Registers a periphery contract address with a specified name
/// @param _name the name to register the contract address under
/// @param _contractAddress the address of the contract to register
function registerPeripheryContract(string calldata _name, address _contractAddress)
```

Retrieving

```solidity
/// @notice Returns the registered contract address by its name
/// @param _name the registered name of the contract
function getPeripheryContract(string calldata _name)
```
