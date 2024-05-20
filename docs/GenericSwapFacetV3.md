# Generic Swap Facet

## How it works

The Generic Swap Facet is used to make single swaps or multiple same-chain swaps in a single transaction. It will send the result of the (final) swap to the receiver.

It does this by using the [LibSwap](./LibSwap.md) library.

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->GenericSwapFacet;
    GenericSwapFacet -- SWAPs --> GenericSwapFacet
    GenericSwapFacet -- withdraw --> USER
```

## Public Methods

- `function swapTokensSingleERC20ToERC20(bytes32 _transactionId,string calldata _integrator,string calldata _referrer,address payable _receive,uint256 _minAmountOut,LibSwap.SwapData calldata _swapData)`

  - Performs a single swap from an ERC20 to another ERC20 token

- `function swapTokensSingleERC20ToNative(bytes32 _transactionId,string calldata _integrator,string calldata _referrer,address payable _receive,uint256 _minAmountOut,LibSwap.SwapData calldata _swapData)`

  - Performs a single swap from an ERC20 to the network's native token

- `function swapTokensSingleNativeToERC20(bytes32 _transactionId,string calldata _integrator,string calldata _referrer,address payable _receive,uint256 _minAmountOut,LibSwap.SwapData calldata _swapData)`

  - Performs a single swap from the network's native token to an ERC20 token

- `function swapTokensGenericV3FromNative(bytes32 _transactionId, string calldata _integrator, string calldata _referrer, address payable _receiver, uint256 _minAmount, SwapData[] calldata _swapData)`

  - Performs multiple swap(s) with the native token as initial input token before withdrawing the final token to the user

- `function swapTokensGenericV3FromERC20(bytes32 _transactionId, string calldata _integrator, string calldata _referrer, address payable _receiver, uint256 _minAmount, SwapData[] calldata _swapData)`
  - Performs multiple swap(s) with any ERC20 token as initial input token before withdrawing the final token to the user

## Swap Data

Some methods accept a `SwapData _swapData` parameter.

Swapping is performed by a swap specific library that expects an array of calldata to can be run on various DEXs (i.e. Uniswap) to make one or multiple swaps before performing another action.

The swap library can be found [here](../src/Libraries/LibSwap.sol).
