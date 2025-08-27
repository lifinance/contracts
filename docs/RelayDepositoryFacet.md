# RelayDepositoryFacet

## How it works

The RelayDepositoryFacet enables direct deposits of assets into Relay Protocol V2 Depositories. This facet supports both native tokens and ERC20 tokens, with optional swap functionality before depositing.

The facet is configured with a specific Relay Depository address during deployment via its constructor parameter. All deposit operations must use this configured depository address.

**Note**: If a deposit amount is higher than the amount associated with the orderId, the overpaid amount will be forwarded to the destination chain (to the receiverAddress specified in the off-chain data associated with orderId)

## ⚠️ SECURITY WARNING

**IMPORTANT**: This facet has a security limitation that integrators must be aware of:

**The facet cannot validate or guarantee that the off-chain data associated with the provided `orderId` corresponds to the `_bridgeData` parameters (e.g., receiver address, destination chain).**

This means:

- There is **no on-chain validation** that the `orderId` matches the intended recipient or destination
- Malicious actors could potentially exploit this by providing mismatched data
- Only use calldata provided by LI.FI backend

## Public Methods

- `startBridgeTokensViaRelayDepository`
- `swapAndStartBridgeTokensViaRelayDepository`

## Relay Depository Data

```solidity
struct RelayDepositoryData {
  bytes32 orderId; // Unique identifier for this deposit order
  address depositorAddress; // The address that will be recorded as the depositor in the Relay Depository
}
```

The `depositorAddress` parameter allows you to specify which address should be recorded as the depositor in the Relay Depository. This is useful for:

- **Proxy contracts**: When a proxy contract calls this facet on behalf of users
- **Integration flexibility**: Allowing the caller to control who appears as the depositor

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

The facet emits one event:

1. `LiFiTransferStarted(BridgeData bridgeData)` - Standard LI.FI transfer event

## Security Features

- **Immutable Depository Address**: The depository address is set during deployment and cannot be changed
- **Reentrancy Protection**: All external methods are protected against reentrancy attacks
- **Zero Address Checks**: Constructor validates that the depository address is not zero
- **Native Token Handling**: Properly handles native token deposits with value validation

## Integration with Relay API

To use this facet effectively:

1. Query the Relay API for available depositories on your target chain
2. Generate a unique `orderId` for the deposit (ensure uniqueness in your application logic)
3. Determine the `depositorAddress` that should be recorded in the Relay Depository
4. Construct the `RelayDepositoryData` with the orderId and depositorAddress
5. Call the appropriate facet method based on whether swapping is needed

**Note**: This implementation is based on the documented Relay Protocol V2 Depository interface. Deposit ID uniqueness should be managed by the integrating application.

## Caller vs Depositor

It's important to understand the distinction between:

- **Caller**: The address that calls the facet functions (msg.sender)
- **Depositor**: The address that will be recorded in the Relay Depository (depositorAddress)

The caller is responsible for:

- Providing the assets to be deposited
- Paying for gas fees
- Approving token transfers (for ERC20 deposits)

The depositor address is what gets recorded in the Relay Depository and will be used for:

- Withdrawal operations
- Balance tracking
- Event emissions

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
  depositorAddress: '0x...', // The address that will be recorded as the depositor in the Relay Depository
}

// For proxy contracts, you might use:
// depositorAddress: userAddress // The actual user's address
//
// For batch operations, you might use:
// depositorAddress: batchOperatorAddress // The batch operator's address

await relayDepositoryFacet.startBridgeTokensViaRelayDepository(
  bridgeData,
  relayDepositoryData,
  { value: ethers.utils.parseEther('1.0') }
)
```
