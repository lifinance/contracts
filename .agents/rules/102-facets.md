---
name: Diamond facets
description: Facet-only requirements and validations
globs:
  - 'src/Facets/**/*.sol'
paths:
  - 'src/Facets/**/*.sol'
---

## Facet Requirements ([CONV:FACET-REQS])

- Location: `src/Facets/`; name contains `Facet`.
- Required functions: `_startBridge` (internal), `swapAndStartBridgeTokensVia{FacetName}`, `startBridgeTokensVia{FacetName}`.
- Modifiers: `nonReentrant`, `refundExcessNative`, `validateBridgeData`, `doesNotContainSourceSwaps`/`doesContainSourceSwaps`, `doesNotContainDestinationCalls`/`doesContainDestinationCalls`.
- Parameter handling:
  - `receiverAddress` first in `{facetName}Data`, must match `bridgeData.receiver` (EVM).
  - Validate `targetChainId` vs `bridgeData.destinationChain` (EVM↔EVM).
- Opaque receiver / calldata-driven flows:
  - If the facet consumes **opaque calldata** such that the final protocol receiver **cannot be reliably validated on-chain** against `bridgeData.receiver` (e.g., receiver encoded in dynamic destination calldata), you **must** add additional security that gates usage to trusted calldata sources.
  - Preferred pattern: require a **backend EIP-712 signature** that commits to the relevant `BridgeData` fields and a hash of the opaque calldata, and verify it on-chain against an authorized signer.
  - Document the changed trust assumptions prominently in the facet NatSpec and in `docs/` (integrators must understand that the receiver is not purely enforced on-chain for these flows).
- Use LibAsset/LibSwap/LibAllowList + Validatable/SwapperV2; reserve native fees via `_depositAndSwap` variants when needed.
- Positive slippage handling: When a bridge has a `minAmountOut` (or similar) parameter (e.g., `outputAmount` in AcrossV4), it must be updated in `swapAndStartBridgeTokensVia{FacetName}` to account for positive slippage from swaps. After `_depositAndSwap` updates `_bridgeData.minAmount`, adjust the bridge's minAmountOut parameter proportionally (accounting for decimal differences if applicable). See `AcrossFacetV4.sol` lines 137-147 for reference implementation.
- Refund routing ([CONV:FACET-REFUNDS]): `msg.sender` may be a relayer or the Permit2Proxy, never assume it is the user. Token value that belongs to the user — positive slippage refunds AND `_depositAndSwap` leftovers — must go to an explicit `refundRecipient` field in `{facetName}Data` (zero-address-checked, revert `InvalidCallData`), not to `msg.sender`. Excess native stays with `msg.sender` (`refundExcessNative(payable(msg.sender))`) because the caller funds native fees. See `PaxosTransitFacet.sol`.
- Native fee guards: on the **swap** entrypoint, never require `nativeFee <= msg.value` (or otherwise tie the bridge's native fee to `msg.value`) — the fee may legitimately be funded by an ERC20→native pre-swap whose output the `_depositAndSwap` `nativeReserve` keeps in the diamond, so `msg.value` can be 0. On the **non-swap** entrypoint `msg.value` is the only native source, so `nativeFee <= msg.value` should be enforced there to prevent paying fees from stray diamond balance. See `PaxosTransitFacet.sol`.

## Non-EVM Support

- Use `bytes` for non-EVM receivers; must be non-zero.
- For non-EVM flows, `bridgeData.receiver == NON_EVM_ADDRESS`.
- For facets with `{facetName}Data.receiverAddress` field (e.g., `_glacisData.receiverAddress`), validate `{facetName}Data.receiverAddress != bytes32(0)` for non-EVM chains and revert with `InvalidNonEVMReceiver()` if zero.
