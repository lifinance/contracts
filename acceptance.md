# Acceptance criteria — PaxosTransitFacet (EXSC-547)

Single-run working file (NOT a tracker). Locked from approved intent: build a Paxos Transit
bridge facet + 100% mock-based unit tests + a demoscript runnable end-to-end against a local
anvil mainnet-fork with a mock TransitStation. Plus house-convention deploy scaffolding. No
on-chain deployment.

## Decisions locked with Daniel

- Demoscript: write + verify against a LOCAL anvil fork with a mock TransitStation + self-signed/dummy quote.
- Scope: facet + 100% tests + demoscript + deploy script + config/paxostransit.json + deployRequirements wiring. NO actual deployment.

## Agent-owned design defaults (reversible; reported at end)

- Use `submitOrder` (Diamond custodies + approves), not `submitOrderWithPermit` (that pulls from user wallet).
- ERC-20-only offer asset (`noNativeAsset` modifier), mirroring GlacisFacet. `msg.value` carries the LayerZero messaging fee (`nativeFee` field), forwarded as `submitOrder{value: nativeFee}`.
- `_startBridge` validates cross-consistency vs the signed quote: `sendingAssetId == quote.route.offerAsset`, `minAmount == quote.offerAmount`, `receiver == quote.receiver`, `distributorCode == LIFI_DISTRIBUTOR_CODE` → else `InformationMismatch`.
- Swap variant: swap with min-out = `quote.offerAmount`; refund positive slippage (received − offerAmount) to caller; bridge exactly `offerAmount`.
- No destination calls, no slippage param (rate locked by signed quote), no refund-to-Diamond path.

## Criteria — if every one passes, this is done & correct

- [ ] `forge build` compiles clean (facet + interface + mock + deploy/update scripts).
- [ ] `forge test --match-contract PaxosTransitFacetTest` shows 0 failures.
- [ ] `forge coverage --match-contract PaxosTransitFacetTest` reports 100% lines/statements/branches/functions for `src/Facets/PaxosTransitFacet.sol` (and the interface) — coverage table printed in transcript.
- [ ] Negative guards covered & asserted: constructor zero-address revert; native sendingAsset revert; each `InformationMismatch` branch (asset / amount / receiver / distributorCode); swap-flag mismatch.
- [ ] Demoscript runs end-to-end against a local anvil mainnet-fork with a deployed mock TransitStation: prints the bridge tx hash and asserts the offer asset moved from the Diamond to the mock + the want-asset receiver = end user. Exit code 0.
- [ ] `bunx tsc-files --noEmit` clean on the demoscript; `bunx solhint` clean on the new .sol files; `bun lint` / prettier clean.
- [ ] Adversarial review pass (correctness + funds-safety + does-it-reproduce) with findings fixed or consciously deferred.
- [ ] (manual) Daniel signs off on the facet design + the distributorCode validation choice. Swap in real Paxos TransitStation addresses + live quote endpoint once Paxos ships (~July 1).
