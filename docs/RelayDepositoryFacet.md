# RelayDepositoryFacet

## How it works

The RelayDepositoryFacet enables direct deposits of assets into Relay Protocol V2 Depositories. This facet supports both native tokens and ERC20 tokens, with optional swap functionality before depositing.

The facet is configured with a specific Relay Depository address during deployment via its constructor parameter. All deposit operations must use this configured depository address.

## Public Methods

- `startBridgeTokensViaRelayDepository`
- `swapAndStartBridgeTokensViaRelayDepository`

## Relay Depository Data

```solidity
struct RelayDepositoryData {
  bytes32 orderId; // Unique identifier for this deposit order
  address depository; // Must match the configured depository address
}
```

## Supported Chains

The RelayDepositoryFacet can be deployed on any EVM-compatible chain where Relay Protocol V2 Depositories are available. Each deployment requires the specific Relay Depository contract address for that chain.

## Constructor Parameters

The facet requires one constructor parameter:

- `_relayDepository`: The address of the Relay Depository contract for the specific chain

## Swap + Deposit

The facet supports swapping tokens before depositing into the Relay Depository. This allows users to:

1. Start with any supported token
2. Swap to the desired deposit token via DEX aggregation
3. Deposit the swapped tokens into the Relay Depository

## Configuration

The RelayDepositoryFacet reads its configuration from `config/relay.json` alongside other Relay protocol settings. Each supported network must have its Relay Depository address configured:

```json
{
  "relaySolver": "0xf70da97812CB96acDF810712Aa562db8dfA3dbEF",
  "mainnet": {
    "relayReceiver": "0xa5f565650890fba1824ee0f21ebbbf660a179934",
    "relayDepository": "0x..."
  },
  "arbitrum": {
    "relayReceiver": "0xa5f565650890fba1824ee0f21ebbbf660a179934",
    "relayDepository": "0x..."
  }
}
```

## Events

The facet emits two events:

1. `RelayDepositoryDeposit(bytes32 indexed orderId, address indexed depository)` - Emitted when a deposit is made
2. `LiFiTransferStarted(BridgeData bridgeData)` - Standard LI.FI transfer event

## Security Features

- **Address Validation**: The provided depository address must match the immutable address set during deployment
- **Reentrancy Protection**: All external methods are protected against reentrancy attacks
- **Zero Address Checks**: Constructor validates that the depository address is not zero
- **Native Token Handling**: Properly handles native token deposits with value validation

## Integration with Relay API

To use this facet effectively:

1. Query the Relay API for available depositories on your target chain
2. Generate a unique `orderId` for the deposit (ensure uniqueness in your application logic)
3. Construct the `RelayDepositoryData` with the orderId and configured depository address
4. Call the appropriate facet method based on whether swapping is needed

**Note**: This implementation is based on the documented Relay Protocol V2 Depository interface. Deposit ID uniqueness should be managed by the integrating application.

## Example Usage

```typescript
// Native ETH deposit
const bridgeData = {
  transactionId: '0x...',
  bridge: 'relay-depository',
  integrator: 'your-dapp',
  referrer: '0x...',
  sendingAssetId: '0x0000000000000000000000000000000000000000', // ETH
  receiver: '0x...',
  minAmount: ethers.utils.parseEther('1.0'),
  destinationChainId: 137, // Polygon
  hasSourceSwaps: false,
  hasDestinationCall: false,
}

const relayDepositoryData = {
  orderId: '0x...',
  depository: '0x...', // Must match the configured address
}

await relayDepositoryFacet.startBridgeTokensViaRelayDepository(
  bridgeData,
  relayDepositoryData,
  { value: ethers.utils.parseEther('1.0') }
)
```
