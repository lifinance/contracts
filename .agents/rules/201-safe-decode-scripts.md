---
name: Safe decode scripts
description: Safe/timelock decode and display conventions for script/deploy/safe
globs:
  - 'script/deploy/safe/**/*.ts'
paths:
  - 'script/deploy/safe/**/*.ts'
---

## Safe Decode and Display ([CONV:SAFE-DECODE])

- **Single entry point for decoded tx display**: Human-readable decoded Safe/timelock transaction data MUST be produced via `formatDecodedTxDataForDisplay(data, context)` from [script/deploy/safe/safe-decode-utils.ts](../../script/deploy/safe/safe-decode-utils.ts). Scripts that show Safe or timelock calldata (e.g. `confirm-safe-tx.ts`, `execute-pending-timelock-tx.ts`) MUST call this function instead of duplicating decode/format logic.
- **Context**: Pass `{ chainId: number, network: string }` so formatters can resolve target names and explorer links. When adding new callers (e.g. new scripts that display pending operations), pass the same context shape.

## Shared Logic Location ([CONV:SAFE-DECODE-UTILS])

- **Decode and formatters live in safe-decode-utils**: `decodeTransactionData`, display helpers (`getTargetName`, `getTargetSuffix`, `getPeripheryDeploymentCheckSuffix`), and formatters (`formatDiamondCutSummary`, `formatTimelockScheduleBatch`, `formatBatchSetContractSelectorWhitelist`, `tryFormatDiamondPayload`) are implemented in [script/deploy/safe/safe-decode-utils.ts](../../script/deploy/safe/safe-decode-utils.ts). Do NOT duplicate these in other Safe scripts; import from safe-decode-utils.
- **decodeDiamondCut**: Remains in [script/deploy/safe/safe-utils.ts](../../script/deploy/safe/safe-utils.ts) (selector map, explorer links). safe-decode-utils imports and calls it; safe-utils MUST NOT import from safe-decode-utils (avoid circular dependency).
- **Known ABIs**: Reliable decoding for common Safe/timelock calls (diamondCut, schedule, scheduleBatch, batchSetContractSelectorWhitelist, registerPeripheryContract) uses explicit ABIs in safe-decode-utils. When adding support for new top-level functions, add the ABI and a branch in `formatDecodedTxDataForDisplay`; keep ABIs in one place.
- **Selector registry**: Selector → name/signature resolution (diamond.json, clearSigning/whitelist configs, well-known signatures, batched + disk-cached 4byte fallback) lives in [script/deploy/safe/selector-registry.ts](../../script/deploy/safe/selector-registry.ts). Both safe-utils and safe-decode-utils import it; keep it dependency-light (fs/path/viem/consola only) so it never creates an import cycle.

## Adding or Changing Decode Behavior

- **New function display**: Add an ABI constant (e.g. `ABI_*`), extend `getAbiForKnownFunction()` if needed, and add a branch in `formatDecodedTxDataForDisplay` that calls the appropriate formatter or prints decoded args. Prefer reusing existing formatters (e.g. diamondCut summary, scheduleBatch table) over ad-hoc logging.
- **New formatter**: If the formatter only depends on `(args, network)` and consola, add it in safe-decode-utils and use the existing helpers (`getTargetSuffix`, etc.). If it needs whitelist or deployment data, use the existing helpers that read from `config/whitelist.json` and deployment helpers; keep paths explicit (e.g. `process.cwd()` or injected) so tests/callers can override.
- **Logging**: `formatDecodedTxDataForDisplay` logs via consola without a network prefix. Callers (e.g. execute-pending-timelock-tx) may prefix other lines with `[networkName]`; do not add a prefix inside the shared formatter unless an optional parameter is introduced and documented.

## Scripts That Display Decoded Data

- **confirm-safe-tx.ts**: Uses `formatDecodedTxDataForDisplay(tx.safeTx.data.data, { chainId: chain.id, network })` for each Safe tx; uses `getTargetName` from safe-decode-utils for the "To:" line in Safe Transaction Details. Unlike `execute-pending-timelock-tx.ts` it also prints the full raw `Data:` hex alongside the decoded display, and that is deliberate: this is where a human commits a signature to exact bytes, and the hex is the artefact they compare against the Ledger screen. Do not extend the "no raw `Data:` hex" rule below to this script.
- **Displaying a stored or decoded value**: every value that comes off a proposal row or out of a decode — including a `string` ABI argument and a signature resolved via 4byte — goes through `asPrintable` / `printableField` from [script/deploy/safe/printable-field.ts](../../script/deploy/safe/printable-field.ts) before it is interpolated into a log line. The notice must stay visually distinct from the value it warns about: it carries its own colour and reset, so it reads correctly wherever it is interpolated — do not strip those, and do not build a notice that inherits the surrounding colour. One module is not on this primitive yet: `render-check-ledger.ts` cleans with a bare `sanitizeProvenanceText`, so it strips control characters but carries no bound, no invisible count and no notice — the values reaching it are machine-reported rather than row text, and moving it over is EXSC-986. New code does not follow that precedent.
- **execute-pending-timelock-tx.ts**: Calls `formatDecodedTxDataForDisplay(operation.data, { chainId, network })` before the Execute/Reject/Skip prompt when `chainId` and `network` are available; passes `network.chainId` and `network.name` into `executeOperation` so the decoded display runs. Do not log raw `Data:` hex when decoded display is shown; optional "Data (raw)" is acceptable if needed for debugging.

## Conventions Summary

| Concern | Location | Notes |
|--------|----------|--------|
| Decoded tx display | safe-decode-utils: `formatDecodedTxDataForDisplay` | Single entry point |
| Selector → function name | safe-decode-utils: `decodeTransactionData` | Diamond ABI, then local registry (`selector-registry.ts`), then batched 4byte (Sourcify) |
| Target name / explorer | safe-decode-utils: `getTargetName`, `getTargetSuffix` | Used by formatters |
| Diamond cut details | safe-utils: `decodeDiamondCut` | Called from safe-decode-utils |
| Known ABIs | safe-decode-utils | One set for all callers |

## Chain Executor Abstraction ([CONV:CHAIN-EXECUTOR])

- **Interfaces**: `IChainExecutor` (Safe `execTransaction`) and `IChainCaller` (generic contract calls + simulation) are defined in `script/common/types.ts`. These are the strategy interfaces — implementations live in `script/deploy/safe/executors/`.
- **Implementations**: `evm-executor.ts`, `tron-executor.ts` (for `IChainExecutor`); `evm-caller.ts`, `tron-caller.ts` (for `IChainCaller`).
- **Factory**: `createChainCaller()` in `script/deploy/safe/executors/create-chain-caller.ts` selects the implementation based on `isTronNetworkKey()`. Uses dynamic imports to lazy-load chain-specific modules.
- **Adding a new chain**: Implement both `IChainExecutor` and `IChainCaller`, add to the factory, and add a network key guard in `tron-network-keys.ts` (or create a new key guard). Consumer scripts should require zero changes.
- **Resource polymorphism**: `IChainSimulateResult.resourceLabel` ("gas" | "energy") enables chain-agnostic display. Use this label in CLI output rather than hardcoding "gas".
