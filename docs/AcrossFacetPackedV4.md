# AcrossFacetPackedV4

## How it works

The AcrossFacetPackedV4 works by forwarding Across V4 specific calls to the [Across SpokePool contract](https://github.com/across-protocol/contracts-v2/blob/main/contracts/SpokePool.sol). Across V4 introduces support for non-EVM chains by using `bytes32` addresses instead of `address` types, allowing for cross-chain bridging to chains like Solana.

The packed version provides gas-optimized bridging by encoding parameters directly into calldata, reducing transaction costs significantly.

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->AcrossFacetPackedV4;
    AcrossFacetPackedV4 -- CALL --> S(Across SpokePool V4)
```

## Key V4 Changes

- **Bytes32 Addresses**: All addresses are now `bytes32` to support non-EVM chains
- **New Deposit Function**: Uses `deposit()` instead of `depositV3()`
- **Enhanced Chain Support**: Supports Solana and other non-EVM chains
- **Improved Gas Efficiency**: Packed calldata reduces transaction costs

## Public Methods

### Native Token Bridging

- `function startBridgeTokensViaAcrossV4NativePacked()`
  - Bridge native assets by passing custom encoded callData
- `function startBridgeTokensViaAcrossV4NativeMin(PackedParameters calldata _parameters)`
  - Bridge native assets by passing minimal required parameters

### ERC20 Token Bridging

- `function startBridgeTokensViaAcrossV4ERC20Packed()`
  - Bridge ERC20 tokens by passing custom encoded callData
- `function startBridgeTokensViaAcrossV4ERC20Min(PackedParameters calldata _parameters, address sendingAssetId, uint256 inputAmount)`
  - Bridge ERC20 tokens by passing minimal required parameters

### Encoding/Decoding Functions

- `function encode_startBridgeTokensViaAcrossV4NativePacked(PackedParameters calldata _parameters)`
  - Generate packed transaction data for native asset transfers
- `function encode_startBridgeTokensViaAcrossV4ERC20Packed(PackedParameters calldata _parameters, address sendingAssetId, uint256 inputAmount)`
  - Generate packed transaction data for ERC20 token transfers
- `function decode_startBridgeTokensViaAcrossV4NativePacked(bytes calldata data)`
  - Decode packed calldata for native transfers
- `function decode_startBridgeTokensViaAcrossV4ERC20Packed(bytes calldata data)`
  - Decode packed calldata for ERC20 transfers

### Utility Functions

- `function setApprovalForBridge(address[] calldata tokensToApprove)`
  - Set token approvals for the Across SpokePool
- `function executeCallAndWithdraw(address _callTo, bytes calldata _callData, address _assetAddress, address _to, uint256 _amount)`
  - Execute calls and withdraw assets (owner only)

## Parameters

### PackedParameters Struct

```solidity
struct PackedParameters {
  bytes32 transactionId;
  bytes32 receiver;
  bytes32 depositor;
  uint64 destinationChainId;
  bytes32 receivingAssetId;
  uint256 outputAmount;
  bytes32 exclusiveRelayer;
  uint32 quoteTimestamp;
  uint32 fillDeadline;
  uint32 exclusivityParameter;
  bytes message;
}
```

### Parameter Descriptions

- `transactionId`: Custom transaction ID for tracking
- `receiver`: Receiving address (bytes32 for non-EVM support)
- `depositor`: Depositor address (bytes32 for non-EVM support)
- `destinationChainId`: Target chain ID
- `receivingAssetId`: Token to receive on destination (bytes32 for non-EVM support)
- `outputAmount`: Expected output amount on destination
- `exclusiveRelayer`: Exclusive relayer address (bytes32 for non-EVM support)
- `quoteTimestamp`: Timestamp of the quote
- `fillDeadline`: Deadline for filling the deposit
- `exclusivityParameter`: This value is used to set the exclusivity deadline timestamp in the emitted deposit
  event. Before this destination chain timestamp, only the exclusiveRelayer (if set to a non-zero address),
  can fill this deposit. There are three ways to use this parameter:
  1. NO EXCLUSIVITY: If this value is set to 0, then a timestamp of 0 will be emitted,
     meaning that there is no exclusivity period.
  2. OFFSET: If this value is less than MAX_EXCLUSIVITY_PERIOD_SECONDS, then add this value to
     the block.timestamp to derive the exclusive relayer deadline.
  3. TIMESTAMP: Otherwise, set this value as the exclusivity deadline timestamp.
- `message`: Additional message data
- `sendingAssetId`: Source token address (for ERC20 transfers)
- `inputAmount`: Amount to bridge (for ERC20 transfers)

## Packed Calldata Format

The packed version optimizes gas usage by encoding parameters directly into calldata with specific byte offsets:

### Native Packed Calldata Mapping

```text
[0:4]   - function selector
[4:12]  - transactionId (bytes8)
[12:44] - receiver (bytes32)
[44:76] - depositor (bytes32)
[76:108] - receivingAssetId (bytes32)
[108:140] - outputAmount (uint256)
[140:172] - destinationChainId (uint64)
[172:204] - exclusiveRelayer (bytes32)
[204:208] - quoteTimestamp (uint32)
[208:212] - fillDeadline (uint32)
[212:216] - exclusivityParameter (uint32)
[216:]   - message
```

### ERC20 Packed Calldata Mapping

```
[0:4]   - function selector
[4:36]  - transactionId (bytes32)
[36:68] - receiver (bytes32)
[68:100] - depositor (bytes32)
[100:120] - sendingAssetId (address) + 12 bytes padding
[120:136] - inputAmount (uint128)
[136:140] - destinationChainId (uint32)
[140:172] - receivingAssetId (bytes32)
[172:204] - outputAmount (uint256)
[204:236] - exclusiveRelayer (bytes32)
[236:240] - quoteTimestamp (uint32)
[240:244] - fillDeadline (uint32)
[244:248] - exclusivityParameter (uint32)
[248:]   - message
```

## Usage Examples

### Encoding Native Transfer

```solidity
// Create packed parameters
PackedParameters memory params = PackedParameters({
    transactionId: bytes32("someID"),
    receiver: bytes32(uint256(uint160(RECEIVER_ADDRESS))),
    depositor: bytes32(uint256(uint160(DEPOSITOR_ADDRESS))),
    destinationChainId: 137,
    receivingAssetId: bytes32(uint256(uint160(USDC_ADDRESS))),
    outputAmount: 1000000,
    exclusiveRelayer: bytes32(0),
    quoteTimestamp: uint32(block.timestamp),
    fillDeadline: uint32(block.timestamp + 3600),
    exclusivityParameter: 0,
    message: ""
});

// Encode the calldata
bytes memory packedCalldata = acrossFacetPackedV4.encode_startBridgeTokensViaAcrossV4NativePacked(params);

// Execute the call
(bool success, ) = address(diamond).call{value: amountNative}(packedCalldata);
```

### Encoding ERC20 Transfer

```solidity
// Create packed parameters
PackedParameters memory params = PackedParameters({
    transactionId: bytes32("someID"),
    receiver: bytes32(uint256(uint160(RECEIVER_ADDRESS))),
    depositor: bytes32(uint256(uint160(DEPOSITOR_ADDRESS))),
    destinationChainId: 137,
    receivingAssetId: bytes32(uint256(uint160(USDC_ADDRESS))),
    outputAmount: 1000000,
    exclusiveRelayer: bytes32(0),
    quoteTimestamp: uint32(block.timestamp),
    fillDeadline: uint32(block.timestamp + 3600),
    exclusivityParameter: 0,
    message: ""
});

// Encode the calldata
bytes memory packedCalldata = acrossFacetPackedV4.encode_startBridgeTokensViaAcrossV4ERC20Packed(
    params,
    USDT_ADDRESS,
    1000000
);

// Execute the call
(bool success, ) = address(diamond).call(packedCalldata);
```

## Getting Sample Calls

To interact with this optimized facet, use requests directly returned by the LI.FI API to ensure the packed parameters are formatted correctly.

## Deployment Requirements

- **Across SpokePool V4**: The V4 SpokePool contract address for the current network
- **Wrapped Native**: The wrapped native token address
- **Owner**: The contract owner address for administrative functions

## Supported Networks

The Across Facet Packed V4 supports all networks that have Across V4 SpokePool deployments, including:

- Ethereum Mainnet
- Arbitrum
- Optimism
- Polygon
- Base
- And other networks with Across V4 support
