---
name: Tron deployment scripts
description: Tron-specific TS conventions for deploy/tron helpers, TronWeb usage, and address handling
globs:
  - 'script/deploy/tron/**/*.ts'
  - 'script/troncast/**/*.ts'
paths:
  - 'script/deploy/tron/**/*.ts'
  - 'script/troncast/**/*.ts'
---

## Tron Script Conventions

### File organization

- **Helpers directory** (`script/deploy/tron/helpers/`): Single-responsibility modules. One concern per file. Prefix with `tron` for Tron-domain wrappers (e.g., `tronPricing.ts`, `tronWebFactory.ts`). Use action-verb names for transformers (`formatAddressForCliDisplay.ts`, `parseTroncastFacetsOutput.ts`).
- **Types**: All Tron-domain interfaces and type aliases in `script/deploy/tron/types.ts`. Follow `I`-prefix convention. Re-export types from helper files when consumers need them.
- **Constants**: Tron-specific constants (fee limits, energy margins, API timeouts, pricing defaults) in `script/deploy/tron/constants.ts`.

### TronWeb vs viem

- **TronWeb**: Use for signing, transaction broadcasting, address codec (hex/base58), and Tron-native RPC calls (`trx.*`, `/wallet/*`).
- **viem**: Use for type safety (`Address`, `Hex`), function encoding (`encodeFunctionData`), and address checksum validation (`getAddress`).
- **Never mix**: Do not use viem for Tron signing or TronWeb for EVM-style encoding.

### TronWeb creation ([CONV:TRONWEB-FACTORY])

- **Always** use `createTronWeb()` / `createTronWebForTvmNetworkKey()` / `createTronWebReadOnly()` from `script/deploy/tron/helpers/tronWebFactory.ts`. Do NOT construct `new TronWeb(...)` directly outside the factory.
- **Codec-only instances**: For address conversion without a private key, use `getTronWebCodecOnly()` / `getTronWebCodecOnlyForNetwork()` from `tronWebCodecOnly.ts`. These are cached per-network.

### Address handling ([CONV:TRON-ADDRESS])

- **Internal representation**: Always viem `Address` (0x-prefixed hex, checksummed).
- **Tron display/API calls**: Convert to base58 via `evmHexToTronBase58()` from `tronAddressHelpers.ts` only at the point of use.
- **Input normalization**: Use `normalizeAddressForNetwork()` from `script/utils/normalizeAddressStringForViem.ts` for user/config input that may be base58 or hex.
- **CLI display**: Use `formatAddressForNetworkCliDisplay()` which auto-detects Tron networks and converts accordingly.

### Energy estimation

- Use `estimateEnergyAndFeeLimit()` from `@lifi/tron-devkit` to derive a fee limit from an estimate. A send whose limit is derived this way is affordable by construction, so it needs no pre-flight — but the two are alternatives, never a pair: see the fixed-limit rule below.
- Always apply the devkit's `DEFAULT_SAFETY_MARGIN` (1.2) so the deploy path and the pre-flight guard agree on what a call costs.
- Pricing for display uses the devkit's `getCurrentPrices()`, cached with TTL-based refresh. Never price a **guard** through it: it substitutes a constant when the read fails and yields `0` for an empty price string, and a cost of zero clears any fee limit. Use `tronEnergyCostInSun()` from `script/deploy/tron/tron-energy-estimate.ts`.

### Before any broadcast ([CONV:TRON-ENERGY-PREFLIGHT])

- Any send you add or touch must go through `sendGuardedTronContractCall()` from `script/deploy/tron/tron-guarded-send.ts`, which refuses when the fee limit cannot be shown to cover the call. A fee limit that cannot pay for a call does not make it fail cleanly — it runs until the limit is spent and aborts part-way, with the energy still charged.
- Pass the broadcast as the `broadcast` callback rather than guarding a bare `.send()`: a call site that holds no raw send has no ordering to get wrong.
- The estimate must be taken against the endpoint the broadcast uses, and priced from the same fee limit the send runs under — a guard that recomputes either is checking a different number.
- That fee limit must be fixed **before** the estimate — a flag, a constant or an env var — and the same value passed to both the guard and the `broadcast` callback. A limit derived from the estimate it is compared against grows with it, so the comparison can never fail and the guard becomes decoration.
- `ALLOW_GAS_ESTIMATE_FALLBACK=<network>` is the only escape hatch. Do not add a second one.
- Native TRX transfers are exempt: they run no VM code, so the fee limit caps nothing they can exceed.

### RPC configuration

- RPC URLs come from env vars only (`ETH_NODE_URI_TRON` / `ETH_NODE_URI_TRONSHASTA`), resolved via `getTronRPCConfig()` from `tronRpcConfig.ts`.
- TronGrid API key: `TRONGRID_API_KEY` env var, injected as `TRON-PRO-API-KEY` header (never URL param).
- URL normalization: TronWeb needs native HTTP root (strip `/jsonrpc`); use `tronWebFullHostFromRpcUrl()`.

### Network key detection ([CONV:TRON-NETWORK-KEY])

- Use `isTronNetworkKey()` from `script/deploy/shared/tron-network-keys.ts` for all Tron-vs-EVM branching. Do NOT compare chain IDs or network names directly.
- Use `isTronTvmChainId()` / `getTronNetworkKeyForChainId()` from `script/deploy/tron/helpers/tronTvmChain.ts` when starting from a chain ID.

### Caching pattern

- Module-level `Map` or closure variable with TTL for expensive lookups (TronWeb codec instances, energy/bandwidth prices).
- Always check cache freshness before returning cached value.
