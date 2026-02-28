---
name: analyze-unverified-contract
description: Analyze an unverified contract — validate input, resolve RPC, disassemble with Heimdall, extract and enrich selectors (known/local/cast/4byte), and produce a single well-structured report file with all insights and no duplicate information
usage: /analyze-unverified-contract <address> <network> | /analyze-unverified-contract <block_explorer_contract_url>
---

# Analyze Unverified Contract Command

> **Usage**: `/analyze-unverified-contract <address> <network>`  
> **Or**: `/analyze-unverified-contract <block_explorer_contract_url>`
>
> Examples: `/analyze-unverified-contract 0x36d3CBD83961868398d056EfBf50f5CE15528c0D base` | `/analyze-unverified-contract https://basescan.org/address/0x...`

Execute the workflow below in order. This file contains all context needed for a new context window.

---

## 1. Input parsing and validation

- **Two arguments** `ADDRESS` and `NETWORK`: use as contract address and network name.
- **Single argument = URL**: block explorer contract URL. Extract **address** (hex after `/address/` or `/contract/`). Map domain to **network**: etherscan.io→mainnet, basescan.org→base, arbiscan.io→arbitrum, polygonscan.com→polygon, snowtrace.io→avalanche, ftmscan.com→fantom, bscscan.com→bsc, optimistic.etherscan.io→optimism, blockscout.com→(chain-specific). If unknown, ask user for network.
- **Validate address**: Ensure address is 0x + 40 hex (e.g. repo helper `isValidEvmAddress` from `script/helperFunctions.sh`, or `[[ "$ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]`). Reject or ask for correction if invalid.

---

## 2. RPC URL resolution

- **Preferred**: From `config/networks.json` — key = network name, field `rpcUrl`. Standalone: `jq -r --arg n "base" '.[$n].rpcUrl // empty' config/networks.json`. With helpers: source `script/helperFunctions.sh` and use `getRpcUrlFromNetworksJson NETWORK` (reads networks.json).
- **Alternative**: `getRPCUrl NETWORK` from `script/helperFunctions.sh` (reads `ETH_NODE_URI_<NETWORK>` from env).
- **Fallback**: If network not in config and env not set, ask user for RPC URL.

---

## 3. Bytecode (optional)

- **Skip if** only disassemble/decompile: Heimdall accepts `<TARGET>` = address and fetches via RPC; no need to run `cast code` first.
- **When needed**: To save bytecode to a file (e.g. for other tools or offline use): `cast code "<ADDRESS>" --rpc-url "<RPC_URL>" > bytecode-<short_addr>.bin`

---

## 4. Heimdall installation check

- Run `command -v heimdall` (or `which heimdall`).
- If **not found**: Tell the user: "Heimdall is not installed. Install with: `curl -L http://get.heimdall.rs | bash`, then in a new terminal run `bifrost`." Offer to continue after they install. Do **not** proceed with disassemble/decompile until heimdall is available.

---

## 5. Heimdall usage (disassemble / decompile)

- **Docs**: https://github.com/Jon-Becker/heimdall-rs/wiki/modules  
- **Shared options**: `-r` / `--rpc-url` = RPC URL; `-o` = output path or `print`; `-d` / `--default` = non-interactive (choose defaults when prompted).
- **Disassemble** (bytecode → opcodes): `heimdall disassemble <TARGET> -r <RPC_URL> -o <OUTPUT>` — `<TARGET>` = address, ENS, or bytecode file path. Optional: `-d` for decimal program counter.
- **Decompile** (bytecode → pseudo-Solidity + ABI): `heimdall decompile <TARGET> -r <RPC_URL> -o <OUTPUT> -d`. Use `--include-sol` and/or `--include-yul` for full output; `--skip-resolving` to skip selector resolution.
- **Outputs**: e.g. `opcodes-<network>-<short_addr>.txt/` (Heimdall may create a directory; opcodes are in `disassembled.asm` inside) or `opcodes.txt`; optional `decompiled-<short_addr>/`.
- **More insight**: `heimdall dump <TARGET> -r <RPC_URL>` (storage slots); `heimdall cfg <TARGET> -r <RPC_URL> -o <OUTPUT>` (control-flow graph). Use when summarizing structure or proxy/storage patterns.

---

## 6. Extract function selectors from opcodes

- **Pattern**: `PUSH4 <8 hex digits>` (e.g. `PUSH4 8388464e`).
- **Exclude**: `0xffffffff` (sentinel), `0x4e487b71` (Error(string)).
- **Extract**: All unique PUSH4 + 8 hex, normalize to `0x` + 8 hex, remove duplicates and excluded.
- **Example**:
  ```bash
  grep -oE 'PUSH4 [0-9a-f]{8}' opcodes.txt | awk '{print "0x"$2}' | sort -u | grep -v '0xffffffff' | grep -v '0x4e487b71'
  ```
- **Output**: Write to e.g. `opcodes-selectors.md` or `<contract>-selectors.md` (list or table Selector | Signature).

---

## 7. Enrich selectors with signatures

**Use this order for speed**: resolve via known + local + cast first (no network delay), then **always** run the 4byte.directory step for every selector still unresolved after cast.

**D. Known selectors** (instant) — 0x01ffc9a7→supportsInterface(bytes4), 0x1626ba7e→isValidSignature(bytes32,bytes), 0x150b7a02→onERC721Received(…), 0xf23a6e61→onERC1155Received(…), 0xbc197c81→onERC1155BatchReceived(…), 0x52d1902d→proxiableUUID(), 0x4f1ef286→upgradeToAndCall(address,bytes), 0x3f707e6b→execute((address,uint256,bytes)[]), 0xb61d27f6→execute(address,uint256,bytes). Add common ERC20/ERC721 (e.g. balanceOf, transfer, approve) if useful.

**B. Local repo** (instant) — `out/<ContractName>.sol/<ContractName>.json` → key `methodIdentifiers`. `grep -r "<selector>" out/` or jq over methodIdentifiers.

**C. cast** (fast, no rate limit) — `cast 4byte <selector>` returns signature; use for each unresolved selector before hitting the API.

**A. 4byte.directory (mandatory for unresolved)** — For every selector still showing no signature after D/B/C, query 4byte.directory and merge any results into the selectors file. **Preferred**: source `script/helperFunctions.sh` and `script/playgroundHelpers.sh`, then run `decodeSelectors4byte` with no args (reads from the selectors file) or pass only the unresolved selectors; use `FOURBYTE_DELAY=0.3`–0.5. **Fallback**: if sourcing the repo scripts fails (e.g. in a minimal env), call the API directly: `GET https://www.4byte.directory/api/v1/signatures/?hex_signature=0x<selector>`, parse `results[].text_signature`, use ~0.3s delay between requests, and update the selectors file with any new signatures. Selectors that remain unknown after 4byte stay as "—" in the table.

Merge all resolved signatures into the selectors file as table **Selector** | **Signature**.

---

## 8. Produce a single well-structured report file

**Requirement**: Write exactly one report file that contains all insights in a clear structure and **no duplicate information** (e.g. do not repeat the full selector table in multiple sections).

- **Path**: `report-unverified-<network>-<short_addr>.md` (e.g. `report-unverified-base-36d3cbd8.md`) in the repo root or a dedicated folder (e.g. `docs/analysis/`). Short addr = first 8 hex chars of address (lowercase).
- **Structure** (use these sections; each piece of information appears only once):

  1. **Metadata** — Contract address, network (and chainId if known), RPC source, analysis date.
  2. **Input & validation** — How the address/network were obtained (e.g. URL parsed), validation result.
  3. **Artifacts** — Table or list of paths only: opcodes file, selectors file (with signature table), optional decompile dir, optional dump/cfg paths. No inline duplication of selector table here.
  4. **Selectors** — Either embed the full Selector | Signature table once in the report, or reference the selectors file and give total count + resolved vs unresolved. Do not repeat the same table elsewhere in the report.
  5. **Interface hints** — Concise mapping: which selectors imply which interfaces (ERC165, ERC1271, ERC721/1155 receivers, UUPS/proxy, Safe-style execute, ERC-4337, EIP-712, etc.). No raw selector list again; refer to section 4 or the selectors file.
  6. **Structure summary** — One-line characterization of the contract (e.g. "Smart account with ERC1271 and UUPS"). If decompile or dump/cfg was run, add 1–3 short bullets (dispatch pattern, proxy slot, dangerous patterns) without repeating selector or artifact paths.
  7. **Optional extras** (only if produced) — Call-flow hints, suggested `cast call` examples for key selectors, storage/CFG notes, repo comparison. Keep brief; reference section 4 for selectors.

- **Chat summary**: In the conversation, give a short summary and point to the report file path; do not paste the full report again.

---

## 9. Repo file reference

| Purpose              | Path |
|----------------------|------|
| Network list + RPC   | `config/networks.json` (`.rpcUrl`) |
| getRPCUrl            | `script/helperFunctions.sh` |
| decodeSelectors4byte (function) | `script/playgroundHelpers.sh` (source after `script/helperFunctions.sh`) |
| Selectors file       | `opcodes-selectors.md` or `<contract>-selectors.md` |
| Report file (output) | `report-unverified-<network>-<short_addr>.md` (Section 8) |
| Heimdall commands    | `script/playground.sh` (commented) |

---

## 10. Additional benefits (optional, for maximum insight)

If run, fold the results into the report (Section 8) in the appropriate subsection; do not duplicate elsewhere.

| Benefit | Description |
|--------|-------------|
| **Interface detection** | Map selectors → interfaces (Section 8.5). ERC165, ERC1271, ERC721/1155 receivers, UUPS/proxy, Safe-style execute. |
| **Call-flow hints** | For patterns (e.g. execute + isValidSignature), state which selectors are needed; add to report Section 8.7. |
| **Decompiled code review** | Note structure (dispatch table, delegatecall targets, storage layout), dangerous patterns, proxy slots; add to report Section 8.6. |
| **cast call examples** | Suggest `cast call <ADDRESS> "<signature>" [args] --rpc-url <RPC>` for key selectors; add to report Section 8.7. |
| **Storage / CFG** | `heimdall dump` / `heimdall cfg`; add artifact paths and brief notes to report Sections 8.3 and 8.6. |
| **Repo comparison** | Compare selector set with `out/*/*.json` methodIdentifiers; add one line to report Section 8.7 if relevant. |
| **Transaction inspect** | For a specific tx: `heimdall inspect <TX_HASH> -r <RPC> -d`; can be referenced in the report if needed. |

Main deliverable: opcodes file, selectors file (with full table), and **one report file** (Section 8) containing all insights without duplication.
