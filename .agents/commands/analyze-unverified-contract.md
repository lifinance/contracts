---
name: analyze-unverified-contract
description: Investigates an unverified contract from an address + network or an explorer URL: proxy detection, Heimdall disassembly, selector extraction and resolution, one markdown report. Use for unknown or unverified contracts, decompiling bytecode, or when /analyze-tx hits an unverified target.
usage: /analyze-unverified-contract <address> <network>  |  /analyze-unverified-contract <block_explorer_contract_url>
---

# Analyze Unverified Contract

Single deliverable: `report-unverified-<network>-<short_addr>.md`, self-contained for a reviewer.

## Conventions

- **`ADDRESS`** — 0x-prefixed 40-hex EVM address (the user input).
- **`NETWORK`** — short network name as keyed in [`config/networks.json`](../../config/networks.json) (e.g. `base`, `arbitrum`, `mainnet`).
- **`TARGET`** — the address Heimdall actually analyzes. Equals `ADDRESS` for direct contracts; equals the resolved implementation for EIP-1967 proxies. Step 3 sets it.
- **`<short_addr>`** — first 8 hex chars of `ADDRESS`, lowercase. Used in every output filename so multiple analyses in the same checkout don't collide.
- **Output naming**: `<purpose>-<network>-<short_addr>.<ext>` (e.g. `opcodes-base-c7828327.txt`, `report-unverified-base-c7828327.md`).

## Bundled helpers

Source `script/helperFunctions.sh` (provides `isValidEvmAddress`, `getRpcUrlFromNetworksJson`, `error`, `warning`), then [`script/playgroundHelpers.sh`](../../script/playgroundHelpers.sh), and use its functions rather than hand-rolled `cast` / `grep` pipelines:

| Function | Step | Output |
|---|---|---|
| `resolveContractTarget ADDRESS RPC_URL` | 3 | `target=… proxy=… kind=direct\|eip1967\|eip1967-beacon\|eip1167\|diamond` (3 lines). For `kind=diamond`, `target` is `<facet1>,<facet2>,…` (comma-separated). |
| `extractSelectorsFromOpcodes OPCODES_FILE` | 5 | one lowercase selector per line |
| `decodeSelectors4byte` (and `decodeSelector4byte`) | 6.4 | merged selectors file with signatures |
| `generateUnverifiedContractReportSkeleton ADDRESS NETWORK` | 7 | markdown skeleton to stdout |

## Workflow

### 1. Parse and validate input

- **Two args** `ADDRESS NETWORK` → use directly.
- **Single arg = URL** → `ADDRESS` is the path segment after `/address/` or `/contract/`; derive `NETWORK` by matching the host against each entry's `explorerUrl` in `config/networks.json` (e.g. `etherscan.io → mainnet`, `optimistic.etherscan.io → optimism`). If the host doesn't resolve, ask the user.
- **Validate**: `isValidEvmAddress "$ADDRESS"`; reject invalid input.
- **Set `$SHORT` once**: `SHORT="$(printf '%s' "${ADDRESS#0x}" | tr '[:upper:]' '[:lower:]' | cut -c1-8)"`.

### 2. Resolve RPC

1. `getRPCUrl "$NETWORK"` (reads `ETH_NODE_URI_<NETWORK>` — the team's private endpoint).
2. `getRpcUrlFromNetworksJson "$NETWORK"` (public `rpcUrl` from `config/networks.json`) only when the env var is unset.
3. Neither resolves → ask the user. Never pick a random public RPC: it leaks the investigation to a third party and may rate-limit Heimdall's bytecode fetch.

### 3. Detect proxies and set TARGET

```bash
eval "$(resolveContractTarget "$ADDRESS" "$RPC_URL")"
# Now $target, $proxy, $kind are set.
```

- `direct` → `TARGET=$ADDRESS`.
- `eip1967`, `eip1967-beacon`, `eip1167` → `TARGET=$target` (Heimdall on the proxy itself yields no selectors).
- `diamond` → split `$target` on commas and run Steps 4–7 per facet (artifacts named `opcodes-$NETWORK-$SHORT-<facet_short>.txt` etc.), then aggregate the per-facet selector tables into one §4.

Record `$proxy` and `$target` in §2. Other proxy patterns (EIP-1822 UUPS pre-1967, GnosisSafe) come back as `kind=direct` with zero selectors in Step 5 — investigate those manually (slot 0, custom proxy slots).

### 4. Disassemble / decompile with Heimdall

Docs: <https://github.com/Jon-Becker/heimdall-rs/wiki/modules>. Install: `command -v heimdall || curl -L https://get.heimdall.rs | bash`. Don't proceed without it.

- **Disassemble** (bytecode → opcodes): `heimdall disassemble "$TARGET" -r "$RPC_URL" -o "opcodes-$NETWORK-$SHORT.txt"`. Optional flag `-d` / `--decimal-counter` — show the program counter in decimal instead of hex. (Different meaning from `-d` in `decompile`.)
- **Decompile** (bytecode → pseudo-Solidity): `heimdall decompile "$TARGET" -r "$RPC_URL" -o "decompiled-$SHORT/" -d`. Here `-d` / `--default` = non-interactive. Add `--include-sol` / `--include-yul` for richer output; `--skip-resolving` to skip Heimdall's own selector resolution (Step 6 does it).
- **Output shape**: Heimdall may create a directory containing `disassembled.asm`; that file is the opcodes input for Step 5.
- **Optional extras** (for richer §6/§7): `heimdall dump` (storage), `heimdall cfg`, `heimdall inspect <TX_HASH>`. Link artifact paths from §3; don't paste output.

### 5. Extract selectors

```bash
extractSelectorsFromOpcodes "opcodes-$NETWORK-$SHORT.txt" > opcodes-selectors.md
```

The default output filename matters: Step 6.4's `decodeSelectors4byte` reads `opcodes-selectors.md` when called with no args.

The extractor takes every `PUSH4`, so the list includes interface IDs the contract queries, selectors of contracts it calls, and other 4-byte literals. Only selectors in the dispatch table (`EQ` + `JUMPI` near the entrypoint) are entrypoints; vet this in §5. For diamonds, `facets()` is the authoritative selector → facet mapping; the opcode set is secondary.

### 6. Resolve selector signatures

Run in order (cheap → rate-limited), stopping per selector at the first match:

1. **Well-known standard selectors** (ERC-165/1271/721/1155 receivers, UUPS, ERC-20/721) from memory — accept a match only after `cast sig "<signature>"` returns that selector.
2. **Local artifacts**: `jq -r '.methodIdentifiers | to_entries[] | "\(.value)\t\(.key)"' out/*.sol/*.json 2>/dev/null | grep -i "<selector-without-0x>"`.
3. **cast**: `cast 4byte "<selector>"` per still-unresolved selector.
4. **4byte.directory**: `decodeSelectors4byte` with no args reads and updates `opcodes-selectors.md`. Set `FOURBYTE_DELAY=0.5` on 429s.

Merge results into `opcodes-selectors.md` as a table **Selector | Signature** (use `—` for selectors that remain unresolved after all four steps).

**Very large contracts** (>500 selectors — diamonds, NFT marketplaces): if steps 1–3 cover ≥80%, skip step 4 and note it in the report. Under token pressure, also skip the optional Heimdall extras; selectors + interface hints + summary are the core deliverable.

### 7. Write the report

```bash
generateUnverifiedContractReportSkeleton "$ADDRESS" "$NETWORK" > "report-unverified-$NETWORK-$SHORT.md"
```

Fill in the seven sections (Metadata, Input & validation, Artifacts, Selectors, Interface hints, Structure summary, Optional extras). Each fact lives in exactly one section: selectors in §4; §5 references §4 by selector group rather than re-listing; artifact paths only in §3.

In chat, give a one-paragraph summary and the report path — don't paste the report.

## Failure modes

| What fails | What to do |
|---|---|
| Heimdall decompile errors or times out | Disassembly suffices for Step 5. Skip decompile and note it in §6. |
| 4byte returns 429 / network error | `decodeSelector4byte` prints `(no match)` and continues. Re-run later with `FOURBYTE_DELAY=1.0`. |
| Opcodes file is huge (>50k lines) | Don't read it into the chat; §3 keeps the path only. Sample with `head -200`. |
| `extractSelectorsFromOpcodes` returns 0 selectors | Almost certainly an unresolved proxy. Re-run Step 3 against a different RPC and check the implementation slot is non-zero. |
