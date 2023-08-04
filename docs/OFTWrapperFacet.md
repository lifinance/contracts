# OFTWrapper Facet

## How it works

The OFTWrapper Facet works by forwarding OFTWrapper specific calls to a [OFTWrapper contract](https://github.com/LayerZero-Labs/oft-wrapper/blob/main/contracts/OFTWrapper.sol). Omnichain Fungible Token (OFT) is LayerZero's token standard.

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->A[OFTWrapperFacet]
    A -- CALL --> B(OFTWrapper)
```

## Public Methods

- `function initOFTWrapper(ChainIdConfig[] calldata chainIdConfigs)`
  - Initializer method. Sets layerzero chain ids for chains.
- `function startBridgeTokensViaOFTWrapper(BridgeData calldata _bridgeData, OFTWrapperData calldata _oftWrapperData)`
  - Simply bridges tokens using OFTWrapper
- `function swapAndStartBridgeTokensViaOFTWrapper(BridgeData memory _bridgeData, SwapData[] calldata _swapData, OFTWrapperData calldata _oftWrapperData)`
  - Performs swap(s) before bridging tokens using OFTWrapper
- `function estimateOFTFeesAndAmountOut(address _sendingAssetId, uint256 _destinationChainId, uint256 _amount, bytes32 _receiver, TokenType _tokenType, bool _useZro, bytes memory _adapterParams, uint256 _callerBps)`
  - Returns a required amount for native fee, zro fee, wrapper fee, caller fee and amount out

## OFTWrapper Specific Parameters

Some of the methods listed above take a variable labeled `_oftWrapperData`.

To populate `_oftWrapperData` you will need to get the chain ID you are bridging to. You can visit the [LayerZero Mainnet Addresses](https://layerzero.gitbook.io/docs/technical-reference/mainnet/supported-chain-ids) to get the list.

This data is specific to OFTWrapper and is represented as the following struct type:

```solidity
/// @param tokenType Type of OFT token(OFT, OFTV2, OFTFeeV2, ProxyOFT, ProxyOFTV2, ProxyOFTFeeV2).
/// @param proxyOFT Address of proxy OFT.
/// @param receiver Receiver address for non-EVM chain.
/// @param minAmount The min qty you would accept on the destination.
/// @param lzFee Estimated fee.
/// @param zroPaymentAddress The address to pay fee in ZRO token.
/// @param adapterParams Parameters for custom functionality.
/// @param feeObj Struct data for caller bps and partner id.
struct OFTWrapperData {
  TokenType tokenType;
  address proxyOFT;
  bytes32 receiver;
  uint256 minAmount;
  uint256 lzFee;
  address zroPaymentAddress;
  bytes adapterParams;
  IOFTWrapper.FeeObj feeObj;
}
```

## Swap Data

Some methods accept a `SwapData _swapData` parameter.

Swapping is performed by a swap specific library that expects an array of calldata to can be run on variaous DEXs (i.e. Uniswap) to make one or multiple swaps before performing another action.

The swap library can be found [here](../src/Libraries/LibSwap.sol).

## LiFi Data

Some methods accept a `BridgeData _bridgeData` parameter.

This parameter is strictly for analytics purposes. It's used to emit events that we can later track and index in our subgraphs and provide data on how our contracts are being used. `BridgeData` and the events we can emit can be found [here](../src/Interfaces/ILiFi.sol).

## Getting Sample Calls to interact with the Facet

In the following some sample calls are shown that allow you to retrieve a populated transaction that can be sent to our contract via your wallet.

All examples use our [/quote endpoint](https://apidocs.li.finance/reference/get_quote-1) to retrieve a quote which contains a `transactionRequest`. This request can directly be sent to your wallet to trigger the transaction.

The quote result looks like the following:

```javascript
const quoteResult = {
  id: '0x...', // quote id
  type: 'lifi', // the type of the quote (all lifi contract calls have the type "lifi")
  tool: 'oftwrapper', // the bridge tool used for the transaction
  action: {}, // information about what is going to happen
  estimate: {}, // information about the estimated outcome of the call
  includedSteps: [], // steps that are executed by the contract as part of this transaction, e.g. a swap step and a cross step
  transactionRequest: {
    // the transaction that can be sent using a wallet
    data: '0x...',
    to: '0x...',
    value: '0x00',
    from: '{YOUR_WALLET_ADDRESS}',
    chainId: 100,
    gasLimit: '0x...',
    gasPrice: '0x...',
  },
}
```

A detailed explanation on how to use the /quote endpoint and how to trigger the transaction can be found [here](https://apidocs.li.finance/reference/how-to-transfer-tokens).

**Hint**: Don't forget to replace `{YOUR_WALLET_ADDRESS}` with your real wallet address in the examples.

### Cross Only

To get a transaction for a transfer from 20 STG on Polygon to STG on Fantom you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=POL&fromAmount=20000000000000000000&fromToken=STG&toChain=FTM&toToken=STG&slippage=0.03&allowBridges=oftWrapper&fromAddress={YOUR_WALLET_ADDRESS}'
```

### Swap & Cross

To get a transaction for a transfer from 10 STG on Polygon to CAKE on Fantom you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=POL&fromAmount=10000000000000000000&fromToken=STG&toChain=FTM&toToken=CAKE&slippage=0.03&allowBridges=oftWrapper&fromAddress={YOUR_WALLET_ADDRESS}'
```
