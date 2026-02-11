---
name: analyze-unverified-contract
description: Analyze an unverified contract — validate input, resolve RPC, disassemble/decompile with Heimdall, extract and enrich selectors (known/local/cast/4byte), summarize and optionally dump storage/CFG
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
- **Outputs**: e.g. `opcodes-<network>-<short_addr>.txt` (or `opcodes.txt`); optional `decompiled-<short_addr>/`.
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

**Use this order for speed**: resolve via known + local + cast first (no network delay), then 4byte.directory only for unresolved.

**D. Known selectors** (instant) — 0x01ffc9a7→supportsInterface(bytes4), 0x1626ba7e→isValidSignature(bytes32,bytes), 0x150b7a02→onERC721Received(…), 0xf23a6e61→onERC1155Received(…), 0xbc197c81→onERC1155BatchReceived(…), 0x52d1902d→proxiableUUID(), 0x4f1ef286→upgradeToAndCall(address,bytes), 0x3f707e6b→execute((address,uint256,bytes)[]), 0xb61d27f6→execute(address,uint256,bytes). Add common ERC20/ERC721 (e.g. balanceOf, transfer, approve) if useful.

**B. Local repo** (instant) — `out/<ContractName>.sol/<ContractName>.json` → key `methodIdentifiers`. `grep -r "<selector>" out/` or jq over methodIdentifiers.

**C. cast** (fast, no rate limit) — `cast 4byte <selector>` returns signature; use for each unresolved selector before hitting the API.

**A. 4byte.directory** (rate-limited) — `GET https://www.4byte.directory/api/v1/signatures/?hex_signature=0x<selector>`, `results[].text_signature`. Use ~0.3s delay between requests. **Repo**: function `decodeSelectors4byte` in `script/playgroundHelpers.sh` (requires `script/helperFunctions.sh` for `isValidSelector`). Usage: source both scripts, then `decodeSelectors4byte 0x8388464e 0x...` or `decodeSelectors4byte` (reads selectors from `opcodes-selectors.md`), or `grep -oE '0x[0-9a-f]{8}' opcodes-selectors.md | sort -u | ... | decodeSelectors4byte --stdin`. Env: `FOURBYTE_DELAY=0.5` to slow requests.

Merge into selectors file as table **Selector** | **Signature**.

---

## 8. Output and summary

- **Paths**: Opcodes file, selectors file (with signatures), optional decompile dir; optional dump/cfg outputs.
- **Summary**: Total selectors, resolved vs unresolved count, interface hints (ERC165, ERC1271, proxy, receivers), and one-line structure note if decompile/dump was used.

---

## 9. Repo file reference

| Purpose              | Path |
|----------------------|------|
| Network list + RPC   | `config/networks.json` (`.rpcUrl`) |
| getRPCUrl            | `script/helperFunctions.sh` |
| decodeSelectors4byte (function) | `script/playgroundHelpers.sh` (source after `script/helperFunctions.sh`) |
| Example selectors    | `opcodes-selectors.md` |
| Heimdall commands    | `script/playground.sh` (commented) |

---

## 10. Additional benefits (optional, for maximum insight)

After the base workflow:

| Benefit | Description |
|--------|-------------|
| **Interface detection** | Map selectors → interfaces: ERC165 (supportsInterface), ERC1271 (isValidSignature), ERC721/1155 receivers, UUPS/proxy (proxiableUUID, upgradeToAndCall), Safe-style execute. Mention in summary. |
| **Call-flow hints** | For patterns (e.g. execute + isValidSignature), state which selectors are needed for a flow (e.g. Permit2 + swap, ERC1271 sign + execute). |
| **Decompiled code review** | Note structure (dispatch table, delegatecall targets, storage layout), dangerous patterns (selfdestruct, delegatecall to input), and proxy slots (EIP-1967) if visible. Not a full audit. |
| **cast call examples** | Suggest `cast call <ADDRESS> "<signature>" [args] --rpc-url <RPC>` for key selectors (e.g. owner(), entryPoint(), supportsInterface(0x...)). |
| **Storage / CFG** | Run `heimdall dump <ADDRESS> -r <RPC>` for storage slots; `heimdall cfg <ADDRESS> -r <RPC> -o <OUTPUT>` for control-flow graph. Use to infer proxy implementation slot or layout. |
| **Repo comparison** | Compare selector set with `out/*/*.json` methodIdentifiers; report overlap (e.g. "matches LiFiDiamond facets") if contract may relate to repo. |
| **Transaction inspect** | For a specific tx: `heimdall inspect <TX_HASH> -r <RPC> -d` (calldata decode, trace, logs). |

Keep main deliverable: opcodes file, selector list with signatures, short summary; treat the rest as optional.
