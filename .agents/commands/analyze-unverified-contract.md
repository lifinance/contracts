---
name: analyze-unverified-contract
description: Investigate an unverified smart contract end-to-end — given an address (or block-explorer URL) and a network, resolve the RPC, detect EIP-1967 proxies, disassemble with Heimdall, extract every function selector, enrich them via local artifacts / cast / 4byte.directory, and emit one structured markdown report. Use this skill whenever a user mentions an unverified or unknown contract; pastes an etherscan/basescan/arbiscan/etc. URL with no source; asks "what does this contract do" or "what functions does this expose" for an address with no published source; asks to decompile, disassemble, or "look inside" bytecode; wants to identify a contract's interfaces (ERC-20 / 721 / 1155 / 4337 / 1271 / UUPS / Safe) from bytecode alone; needs to enumerate selectors for an opaque contract; or is chained from /analyze-tx because the target turned out to be unverified. Even partial phrasings like "decompile this proxy" or "I have a contract address but no ABI" should trigger.
usage: /analyze-unverified-contract <address> <network>  |  /analyze-unverified-contract <block_explorer_contract_url>
---

# Analyze Unverified Contract

**Goal**: turn an unknown address into a self-contained markdown report a reviewer can read in one sitting. Single deliverable: `report-unverified-<network>-<short_addr>.md`.

## Conventions

Defined once; used throughout.

- **`ADDRESS`** — 0x-prefixed 40-hex EVM address (the user input).
- **`NETWORK`** — short network name as keyed in [`config/networks.json`](../../config/networks.json) (e.g. `base`, `arbitrum`, `mainnet`).
- **`TARGET`** — the address Heimdall actually analyzes. Equals `ADDRESS` for direct contracts; equals the resolved implementation for EIP-1967 proxies. Step 3 sets it.
- **`<short_addr>`** — first 8 hex chars of `ADDRESS`, lowercase. Used in every output filename so multiple analyses in the same checkout don't collide.
- **Output naming**: `<purpose>-<network>-<short_addr>.<ext>` (e.g. `opcodes-base-c7828327.txt`, `report-unverified-base-c7828327.md`).

## Bundled helpers

This skill ships four exported bash functions in [`script/playgroundHelpers.sh`](../../script/playgroundHelpers.sh). Source `script/helperFunctions.sh` (provides `isValidEvmAddress`, `getRpcUrlFromNetworksJson`, `error`, `warning`) and then `script/playgroundHelpers.sh`. Then call:

| Function | Replaces | Output |
|---|---|---|
| `resolveContractTarget ADDRESS RPC_URL` | Step 3 — manual `cast storage` / `cast code` / `cast call facets()` reads | `target=… proxy=… kind=direct\|eip1967\|eip1967-beacon\|eip1167\|diamond` (3 lines). For `kind=diamond`, `target` is `<facet1>,<facet2>,…` (comma-separated). |
| `extractSelectorsFromOpcodes OPCODES_FILE` | Step 5 — manual `grep \| awk \| sort \| grep -v` pipeline | one lowercase selector per line |
| `decodeSelectors4byte` (and `decodeSelector4byte`) | Step 6.4 — manual API calls | merged selectors file with signatures |
| `generateUnverifiedContractReportSkeleton ADDRESS NETWORK` | Step 7 — typing out the 7-section template | markdown skeleton to stdout |

Prefer the helpers. They're consistent with the rest of `script/playgroundHelpers.sh`, handle edge cases (empty slots, mixed-case hex, duplicate selectors, rate limits), and short-circuit invalid input early.

## Workflow

### 1. Parse and validate input

- **Two args** `ADDRESS NETWORK` → use directly.
- **Single arg = URL** → extract `ADDRESS` from the path (segment after `/address/` or `/contract/`) and derive `NETWORK` from the host. Look up the host in `config/networks.json` (each network entry's `explorerUrl` field) rather than hardcoding a list — the repo supports 60+ networks. For the common cases: `etherscan.io → mainnet`, `basescan.org → base`, `arbiscan.io → arbitrum`, `polygonscan.com → polygon`, `optimistic.etherscan.io → optimism`. If the host doesn't resolve, ask the user.
- **Validate**: `isValidEvmAddress "$ADDRESS"`. Reject invalid input rather than guessing.
- **Set `$SHORT` once** (the first 8 hex chars of `ADDRESS` in lowercase — used by every output filename in steps 4–7): `SHORT="$(printf '%s' "${ADDRESS#0x}" | tr '[:upper:]' '[:lower:]' | cut -c1-8)"`.

### 2. Resolve RPC

- **Preferred**: `getRpcUrlFromNetworksJson "$NETWORK"` (reads `config/networks.json`).
- **Alternative**: `getRPCUrl "$NETWORK"` (reads `ETH_NODE_URI_<NETWORK>` from env).
- **Fallback**: if neither resolves, ask the user. Do not pick a random public RPC — it leaks the investigation to a third party and may rate-limit during Heimdall's bytecode fetch.

### 3. Detect proxies and set TARGET

```bash
eval "$(resolveContractTarget "$ADDRESS" "$RPC_URL")"
# Now $target, $proxy, $kind are set.
```

If `$kind` is `direct`, set `TARGET=$ADDRESS`. If `$kind` is `eip1967`, `eip1967-beacon`, or `eip1167`, set `TARGET=$target` (the resolved implementation). If `$kind` is `diamond`, **iterate** — split `$target` on commas and run Steps 4–7 once per facet, writing artifacts as `opcodes-$NETWORK-$SHORT-<facet_short>.txt` etc., then aggregate the per-facet selector tables into a single §4 in the report. Record `$proxy` (the diamond / proxy address) and `$target` (impl or facet list) in §2.

Proxies hold dispatch bytecode only — running Heimdall on the proxy itself yields an empty selector list. The helper covers EIP-1967 standard, EIP-1967 beacon, EIP-1167 (Clones), and EIP-2535 (Diamond); for the less-common patterns (EIP-1822 UUPS pre-1967, GnosisSafe) you'll see `kind=direct` and zero selectors in Step 5 — that's your signal to investigate manually (slot 0, custom proxy slots, etc.).

### 4. Disassemble / decompile with Heimdall

Docs: <https://github.com/Jon-Becker/heimdall-rs/wiki/modules>. Install: `command -v heimdall || curl -L https://get.heimdall.rs | bash`. Don't proceed without it.

- **Disassemble** (bytecode → opcodes): `heimdall disassemble "$TARGET" -r "$RPC_URL" -o "opcodes-$NETWORK-$SHORT.txt"`. Optional flag `-d` / `--decimal-counter` — show the program counter in decimal instead of hex. (Different meaning from `-d` in `decompile`.)
- **Decompile** (bytecode → pseudo-Solidity): `heimdall decompile "$TARGET" -r "$RPC_URL" -o "decompiled-$SHORT/" -d`. Here `-d` / `--default` = non-interactive. Add `--include-sol` / `--include-yul` for richer output; `--skip-resolving` to skip Heimdall's own selector resolution (we do it ourselves in Step 6, more thoroughly).
- **Output shape**: Heimdall may create a directory containing `disassembled.asm`. Treat that file as the opcodes input for Step 5.
- **Optional extras** (only if you want richer §6/§7 in the report): `heimdall dump` (storage slots), `heimdall cfg` (control-flow graph), `heimdall inspect <TX_HASH>` (a specific tx through this contract). Link the artifact paths from §3 of the report; don't paste their full output.

### 5. Extract selectors

```bash
extractSelectorsFromOpcodes "opcodes-$NETWORK-$SHORT.txt" > opcodes-selectors.md
```

The default output filename matters: Step 6.4's `decodeSelectors4byte` reads `opcodes-selectors.md` when called with no args.

**Caveat — false positives.** `PUSH4` matches every 4-byte constant in bytecode, not just this contract's selectors. Common false positives: interface IDs passed to `supportsInterface(bytes4)` (e.g. `0x80ac58cd` = ERC-721 — the contract is *asking about* the interface, not exposing it); selectors of external contracts the code calls (e.g. `token.transfer` from a router); 4-byte literals from `keccak256(...)`. Vet resolved signatures in §5 of the report — selectors that appear in the dispatch jump table (paired with `EQ` + `JUMPI` near the entrypoint) are real entrypoints; selectors that only appear once, embedded mid-function, are likely false positives. For diamonds, use the `facets()` return as the authoritative selector → facet mapping and treat the opcode-extracted set as a secondary signal only.

### 6. Resolve selector signatures

**Order matters** — local resolution is free; the API is rate-limited. Run in order, marking each selector as resolved as soon as one source matches.

1. **Known table** (instant, in-memory): `0x01ffc9a7` supportsInterface(bytes4); `0x1626ba7e` isValidSignature(bytes32,bytes); `0x150b7a02` onERC721Received(...); `0xf23a6e61` onERC1155Received(...); `0xbc197c81` onERC1155BatchReceived(...); `0x52d1902d` proxiableUUID(); `0x4f1ef286` upgradeToAndCall(address,bytes); `0xb61d27f6` execute(address,uint256,bytes); `0x3f707e6b` execute((address,uint256,bytes)[]). Add ERC20/721 standards (balanceOf, transfer, approve, ownerOf) if relevant.
2. **Local artifacts** (instant): `out/*/<ContractName>.json` → `.methodIdentifiers`. `jq -r '.methodIdentifiers | to_entries[] | "\(.value)\t\(.key)"' out/*.sol/*.json 2>/dev/null | grep -i "<selector-without-0x>"`.
3. **cast** (fast, no rate limit): `cast 4byte "<selector>"` for each still-unresolved selector.
4. **4byte.directory** (rate-limited; covers everything else): `decodeSelectors4byte` with no args reads `opcodes-selectors.md` and updates it. Set `FOURBYTE_DELAY=0.5` if you hit 429s.

Merge results into `opcodes-selectors.md` as a table **Selector | Signature** (use `—` for selectors that remain unresolved after all four steps).

**Short-circuit for very large contracts** (>500 selectors — diamonds, NFT marketplaces): if steps 1+2+3 already cover ≥80% of selectors, skip step 4 and note it in the report. The marginal value of resolving the long tail via 4byte is low and the runtime cost is high.

### 7. Write the report

```bash
generateUnverifiedContractReportSkeleton "$ADDRESS" "$NETWORK" > "report-unverified-$NETWORK-$SHORT.md"
```

Then fill in the body of each section. The skeleton already has the seven sections (Metadata, Input & validation, Artifacts, Selectors, Interface hints, Structure summary, Optional extras) — see the function definition in `script/playgroundHelpers.sh` for the canonical layout.

**Rule for the whole report: each fact lives in exactly one section.** Selectors go in §4; interface mapping in §5 references §4 by selector group, not by re-listing; artifact paths in §3, never repeated. A reference like "see §4" is fine and preferred over copying.

**Chat summary**: in the conversation, give a one-paragraph summary and the report path. Don't paste the full report back — the user can open the file.

## Failure modes

| What fails | What to do |
|---|---|
| `getRpcUrlFromNetworksJson` returns empty | Try `getRPCUrl` (env-based). If still empty, ask the user. Don't pick a public RPC unilaterally — see Step 2. |
| `cast storage` returns empty / `0x0` | EIP-1967 slot was never written → not a proxy (or uses a non-standard slot). `resolveContractTarget` handles this gracefully and returns `kind=direct`. |
| Heimdall decompile errors or times out | Disassemble-only is sufficient for selector extraction (Step 5). Skip decompile and note in §6 that decompile was not available. |
| 4byte returns 429 / network error | `decodeSelector4byte` prints `(no match)` and the loop continues — no abort. Re-run later with `FOURBYTE_DELAY=1.0` to fill in. |
| Opcodes file is huge (>50k lines) | Don't read it into the chat. §3 of the report keeps the path only. If you need a sample, `head -200`. |
| `extractSelectorsFromOpcodes` returns 0 selectors | Almost certainly an unresolved proxy. Re-run Step 3 against a different RPC and verify the implementation slot returned a non-zero address. |
| Token budget pressure on a very large contract | Skip step 6.4 (4byte for unknown selectors) and the optional extras in step 4. The core deliverable (selectors + interface hints + summary) survives without them. |
