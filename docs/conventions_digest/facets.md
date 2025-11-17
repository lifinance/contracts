# Diamond Facet Requirements

[CONV:FACET-REQS]

- Location: `src/Facets/`; name contains `Facet`.

- Required functions: `_startBridge` (internal), `swapAndStartBridgeTokensVia{FacetName}`, `startBridgeTokensVia{FacetName}`.

- Modifiers: `nonReentrant`, `refundExcessNative`, `validateBridgeData`,

  `doesNotContainSourceSwaps`/`doesContainSourceSwaps`,

  `doesNotContainDestinationCalls`/`doesContainDestinationCalls`.

- Parameter handling:

  - `receiverAddress` first in `{facetName}Data`, must match `bridgeData.receiver` (EVM).

  - Validate `targetChainId` vs `bridgeData.destinationChain` (EVM↔EVM).

[CONV:EVENTS]

- `LiFiTransferStarted`: must be emitted at the end of the internal `_startBridge` function, after all validations and external bridge calls have completed successfully.

- `LiFiTransferCompleted`: only in Executor.

- `LiFiTransferRecovered`: only in Receiver contracts.

- `GenericSwapCompleted`: for same-chain swaps.

[CONV:NON-EVM]

- Use `bytes` for non-EVM receivers; must be non-zero.

- For non-EVM flows, `bridgeData.receiver == NON_EVM_ADDRESS`.

