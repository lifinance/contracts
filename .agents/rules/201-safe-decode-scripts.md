---
name: Safe decode scripts
description: Safe/timelock decode and display conventions for script/deploy/safe
globs:
  - 'script/deploy/safe/**/*.ts'
paths:
  - 'script/deploy/safe/**/*.ts'
---

## Safe Decode and Display ([CONV:SAFE-DECODE])

There are two renderers of decoded calldata, and which one a script uses is
decided by where the output lands — not by preference. Do not write a third,
and do not duplicate decode logic into a calling script.

- **Inside the signer view** (`confirm-safe-tx.ts`): `buildCalldataEffectLines(data, context)` from [script/deploy/safe/calldata-effect-lines.ts](../../script/deploy/safe/calldata-effect-lines.ts). It **returns lines** and writes nothing, so the caller places the block at its own column inside THE CALLDATA DOES. Context is `{ network, indent, target }`. Every call it renders opens with the function's name and selector, then a one-line summary of the effect. It renders under zone 1's rule — it states, it never grades. Fields a signer cannot decide anything with are simply not printed: the salt never, the predecessor and the per-call value only when non-zero. Element counts are the exception — a bounded list says how many it held back, because an array length is proposer-controlled and a truncation that says nothing reads as a shorter payload.
- **Everywhere else** (`execute-pending-timelock-tx.ts`): `formatDecodedTxDataForDisplay(data, context)` from [script/deploy/safe/safe-decode-utils.ts](../../script/deploy/safe/safe-decode-utils.ts), which writes to consola. Context is `{ chainId, network, indent? }`.
- **A new caller picks by destination**: a block composed into a wider layout takes the line builder; a script that simply prints a decode takes the consola path. Migrating `execute-pending-timelock-tx.ts` onto the line builder — and retiring the consola formatters with it — is deliberately deferred: that script drives execution rather than signing, and its prompt was not part of the signer-view redesign.
- **A summarising sentence is the renderer's own syntax.** Anything that composes English about the payload takes its verb from a closed set the code owns and quotes the decoded value it keyed on, leaving it ungraded: a `diamondCut` carrying `action: 7` renders as `action "7" on 2 functions →`, never with a verb the proposer supplied. This applies to both renderers and to anything that replaces them.

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

- **confirm-safe-tx.ts**: Uses `buildCalldataEffectLines(tx.safeTx.data.data, { network, indent, target })` for each Safe tx and prints the returned block itself; uses `getTargetName` from safe-decode-utils for the "To:" line in Safe Transaction Details. Unlike `execute-pending-timelock-tx.ts` it can print the full raw `Data:` hex alongside the decoded display — a fingerprint by default, the whole payload under `--raw` — and that reachability is deliberate: this is where a human commits a signature to exact bytes, and the hex is the artefact they compare against the Ledger screen. Do not extend the "no raw `Data:` hex" rule below to this script.
- **Displaying a stored or decoded value**: every value that comes off a proposal row or out of a decode — including a `string` ABI argument and a signature resolved via 4byte — goes through `asPrintable` / `printableField` from [script/deploy/safe/printable-field.ts](../../script/deploy/safe/printable-field.ts) before it is interpolated into a log line. The notice must stay visually distinct from the value it warns about: it carries its own colour and reset, so it reads correctly wherever it is interpolated — do not strip those, and do not build a notice that inherits the surrounding colour. Not every module printing to this prompt is on the primitive yet: `render-check-ledger.ts`, `delegatecall-gate.ts` and the provenance block still clean with a bare `sanitizeProvenanceText`, which strips control characters but discloses nothing — no invisible count, no confusable count, no notice. Their bounds differ rather than being uniformly absent: `delegatecall-gate.ts` clips at 80 code points and the provenance block bounds its reason and commit, while `render-check-ledger.ts` bounds nothing. Only `render-check-ledger.ts` reports machine values; `delegatecall-gate.ts` renders a proposer-controlled operation value and the provenance block renders stored row text, so what those two lack is the disclosure, not a reason to need none. Putting all three on the primitive is EXSC-986. New code does not follow that precedent.
- **execute-pending-timelock-tx.ts**: Calls `formatDecodedTxDataForDisplay(operation.data, { chainId, network })` before the Execute/Reject/Skip prompt when `chainId` and `network` are available; passes `network.chainId` and `network.name` into `executeOperation` so the decoded display runs. Do not log raw `Data:` hex when decoded display is shown; optional "Data (raw)" is acceptable if needed for debugging.

## Conventions Summary

| Concern | Location | Notes |
|--------|----------|--------|
| Decoded tx display, in the signer view | calldata-effect-lines: `buildCalldataEffectLines` | Returns lines; states, never grades |
| Decoded tx display, everywhere else | safe-decode-utils: `formatDecodedTxDataForDisplay` | Writes to consola |
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
