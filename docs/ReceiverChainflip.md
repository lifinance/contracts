# ReceiverChainflip

## Description

Periphery contract used for receiving cross-chain transactions via Chainflip and executing arbitrary destination calls. Inherits from WithdrawablePeriphery to allow the owner to recover stuck assets.

## Setup

The contract is initialized with:
- owner: Address that can withdraw stuck funds
- executor: Contract used to perform swaps
- chainflipVault: Authorized Chainflip vault that can call this contract

## How To Use

The contract has one method which will be called by the Chainflip vault:

```solidity
  /// @notice Receiver function for Chainflip cross-chain messages
  /// @dev This function can only be called by the Chainflip Vault on this network
  /// @param srcChain The source chain according to Chainflip's nomenclature
  /// @param srcAddress The source address on the source chain
  /// @param message The message sent from the source chain
  /// @param token The address of the token received
  /// @param amount The amount of tokens received
  function cfReceive(
    uint32 srcChain,
    bytes calldata srcAddress,
    bytes calldata message,
    address token,
    uint256 amount
  ) external payable
```

The message parameter contains:
- transactionId: bytes32 identifier for the cross-chain transaction
- swapData: Array of LibSwap.SwapData for executing destination swaps
- receiver: Address that will receive the tokens after any swaps

## Token Handling

- For ERC20 tokens, the contract approves the executor to spend the received tokens before executing swaps
- For native tokens (ETH), the contract forwards the received value directly to the executor
- All approvals are reset to 0 after the operation completes
- If destination swaps fail, the original bridged tokens (ERC20 or native) will be sent directly to the receiver address
