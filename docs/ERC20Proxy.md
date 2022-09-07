# ERC20 Proxy

## Description

Periphery contract used for safe transfers to the Executor contract for arbitrary contract calls

## How To Use

The contract is meant to be used in conjunction with the Executor contract. Users can approve tokens
to be spent by the ERC20 Proxy and in turn the Executor will pull those tokens in to be used in any
arbitrary execution transaction.

Authorized contracts (e.g. Executor) are able to call the following method to pull tokens and use in
contract calls.

```solidity
/// @notice Transfers tokens from one address to another specified address
/// @param tokenAddress the ERC20 contract address of the token to send
/// @param from the address to transfer from
/// @param to the address to transfer to
/// @param amount the amount of tokens to send
function transferFrom(
    address tokenAddress,
    address from,
    address to,
    uint256 amount
)
```

The following utility method can be called by the owner of the contract to set which contracts are
authorized to call the `transferFrom` method

```solidity
/// @notice Sets whether or not a specified caller is authorized to call this contract
/// @param caller the caller to change authorization for
/// @param authorized specifies whether the caller is authorized (true/false)
function setAuthorizedCaller(address caller, bool authorized)
```
