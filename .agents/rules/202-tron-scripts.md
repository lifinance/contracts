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

- Use `estimateEnergyAndFeeLimit()` from `script/deploy/tron/helpers/estimateContractEnergy.ts` for fee limit calculation.
- Always apply the safety margin from constants (`ENERGY_SAFETY_MARGIN`, default 1.2).
- Pricing uses cached values via `tronPricing.ts` with TTL-based refresh.

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
