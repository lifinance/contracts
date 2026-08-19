---
name: deprecate-network
description: Deprecate one or more networks by removing their entries from networks.json, foundry.toml, the target state, the bridge/integration configs, the whitelist, the health-check exemptions, and the per-network deployment logs
usage: /deprecate-network <network1> [network2] [network3] ...
---

# Deprecate Network Command

> **Usage**: `/deprecate-network <network1> [network2] [network3] ...`

## Overview

This command completely removes a network (or multiple networks) from the codebase by:

1. Removing the network entry from `config/networks.json`
2. Removing the RPC endpoint entry from `foundry.toml` under `[rpc_endpoints]`
3. Removing the etherscan entry from `foundry.toml` under `[etherscan]`
4. Removing the network entry from `script/deploy/_targetState.json` (removes both production and staging environments)
5. Removing the per-network deployment log files in `deployments/` that match the network name pattern
6. Removing the network from every bridge/integration config under `config/` that carries a per-network entry
7. Removing the network from `CORE_FACET_EXEMPTIONS` in `script/deploy/healthCheckInvariants.ts`
8. Hand-removing the network's blocks from `config/whitelist.json` (not via the generator)
9. Marking — not removing — the network in any hardcoded chainId mapping under `src/Facets/`

The master deployment log (`deployments/_deployments_log_file.json`) and `archive/config/*`
are **preserved**: they are historical records, not a list of active networks.

## How to Use

1. Type `/deprecate-network` followed by one or more network names (space-separated)
2. The command will automatically:
   - Validate that the networks exist in `config/networks.json`
   - Remove network entries from `config/networks.json`
   - Remove RPC endpoint entries from `foundry.toml`
   - Remove etherscan entries from `foundry.toml`
   - Remove network entries from `script/deploy/_targetState.json`
   - Delete the per-network deployment log files matching the network pattern
   - Grep the repo and remove the network from every bridge/integration config that has it
   - Remove the network from `CORE_FACET_EXEMPTIONS` in `script/deploy/healthCheckInvariants.ts`
   - Hand-remove the network's `PERIPHERY` and `DEXS[].contracts` blocks from `config/whitelist.json`
   - Flag any hardcoded chainId mapping in `src/Facets/` for a comment instead of a deletion
   - Display a summary of all changes made, including the records deliberately preserved

## Examples

### Deprecate a single network:

```text
/deprecate-network fantom
```

### Deprecate multiple networks:

```text
/deprecate-network fantom harmony evmos
```

## Execution Steps

When `/deprecate-network` is invoked with network names:

1. **Validate network names**:

   - Read `config/networks.json` to verify all specified networks exist
   - If a network doesn't exist, warn the user but continue with other networks
   - Display list of networks to be deprecated for confirmation

2. **Remove from `config/networks.json`**:

   - Read the JSON file
   - For each network, remove the entire network object (e.g., `"fantom": { ... }`)
   - Write the updated JSON back to the file
   - Preserve JSON formatting and indentation

3. **Remove from `foundry.toml` - RPC endpoints**:

   - Read `foundry.toml`
   - Locate the `[rpc_endpoints]` section
   - For each network, remove the line: `{network} = "${ETH_NODE_URI_{NETWORK}}"` (case-insensitive matching)
   - Preserve TOML formatting and comments

4. **Remove from `foundry.toml` - Etherscan**:

   - Locate the `[etherscan]` section
   - For each network, remove the entire etherscan entry block:

     ```toml
     {network} = { key = "...", url = "...", chain = "..." }
     ```

   - Handle entries that may span multiple lines
   - Preserve TOML formatting and comments

5. **Remove from `script/deploy/_targetState.json`**:

   - Read the target state JSON file
   - For each network, remove the entire network entry (e.g., `"fantom": { ... }`)
   - This removes both production and staging environments for the network
   - Use `jq` to remove the network: `jq 'del(.["{network}"])'` or equivalent
   - Write the updated JSON back to the file
   - Preserve JSON formatting and indentation
   - If the network doesn't exist in target state, skip silently (not an error)

6. **Remove per-network deployment log files**:

   - For each network, delete all files in `deployments/` directory matching:
     - `{network}.json`
     - `{network}.staging.json`
     - `{network}.diamond.json`
     - `{network}.diamond.staging.json`
   - Use case-insensitive matching for network names
   - If a file doesn't exist, skip silently (not an error)
   - **Do NOT touch `deployments/_deployments_log_file.json`** — see step 7

7. **Preserve the historical records** (do not delete):

   - `deployments/_deployments_log_file.json` (the master log) keeps the deprecated
     network's records. It is the deployment history across all networks and is not
     scoped to the currently-active set; removing entries destroys the audit trail of
     what was deployed where. Both #2004 (corn) and #2141 (taiko et al.) deliberately
     left the deprecated networks' records in place.
   - `archive/config/*` is historical by definition — leave every deprecated-network
     value there untouched.
   - This is easy to get wrong in the opposite direction: a grep for the network name
     will hit both of these, and they must be reported as intentional keeps, not
     offered as cleanup candidates.

8. **Scrub the bridge/integration configs**:

   - Beyond `config/networks.json`, most `config/*.json` files carry per-network entries
     for a specific bridge or integration, and every real deprecation has had to clean
     them. Observed across #2004, #2141 and #2222: `config/gaszip.json`,
     `config/permit2Proxy.json`, `config/squid.json`, `config/stargateV2.json`,
     `config/relay.json`, `config/glacis.json`, `config/garden.json`,
     `config/layerswap.json`, `config/symbiosis.json`.
   - **Do not work from that list** — it grows every time an integration is added.
     Drive this step from a repo-wide grep instead:

     ```bash
     grep -rn --exclude-dir={node_modules,.git,out,cache,broadcast,typechain,lib} \
       -i "{network}" config/ script/ src/ tasks/ test/
     ```

   - Remove the network's entry from every integration config that has one. Keys are
     usually a plain `"{network}": <value>` pair, but some files nest the network under
     a per-integration object — check the surrounding structure before deleting.
   - Report anything the grep surfaces outside `config/` (scripts, docs, comments) in
     the step 13 review rather than deleting it silently.

9. **Remove from `CORE_FACET_EXEMPTIONS`** in `script/deploy/healthCheckInvariants.ts`:

   - Delete the network from the `networks` array of every exemption that lists it.
   - This is CI-enforced: `script/deploy/healthCheckInvariants.test.ts` has a test
     `every exempt network is a known network` asserting each exemption network exists
     in `config/networks.json`, so a leftover entry fails the TS test suite.
   - If removing the network empties an exemption's `networks` array, remove the whole
     exemption object.
   - Verify with `bun test:ts` (the TS suite; a bare `bun test` runs the Solidity tests
     instead and reports spurious failures).

10. **Remove from the whitelist** — by hand, surgically:

    - **Do NOT run `bun update-whitelist-periphery`.** The committed
      `config/whitelist.json` is out of sync with the generator, so the generator
      rewrites the entire `PERIPHERY` section for all networks (~2100 lines of churn)
      and swamps the deprecation diff, making it unreviewable.
    - Instead, hand-remove exactly two kinds of block from `config/whitelist.json`:
      - the `PERIPHERY.{network}` key (4-space indent), and
      - every `DEXS[].contracts.{network}` key (8-space indent) — a network typically
        appears under several DEXs, so remove all of them.
    - The resulting diff for this file must be **deletions only**. Verify:

      ```bash
      git diff --numstat config/whitelist.json   # additions column must be 0
      ```

    - **Do not touch `config/whitelist.staging.json`** — it is gitignored
      (`.gitignore`) and must never appear in the diff.

11. **Handle chainId mappings inside facets** (`src/Facets/`):

    - Some facets carry hardcoded `chainId -> LayerZero eid` or `chainId -> CCTP domain`
      mappings (e.g. `AcrossV4SwapFacet.sol`). If the deprecated network appears in one,
      **do not remove the entry** — the underlying bridge may still support that chain,
      and the mapping describes the bridge's coverage, not LI.FI's.
    - Add a comment above the entry marking it for removal on the next modification of
      the facet. A comment-only change leaves the compiled bytecode identical, so it
      triggers neither a contract version bump nor a re-audit.
    - Wording template (see the Taiko entry added in #2141 and the Moonbeam entry added
      in #2222, both in `src/Facets/AcrossV4SwapFacet.sol`):

      ```solidity
      // Moonbeam is no longer supported by LI.FI (deprecated in EXSC-796); Across still supports it.
      // Remove this entry the next time this facet is modified.
      if (_chainId == 1284) return 30126; // Moonbeam
      ```

    - Confirm bytecode really is unchanged before claiming it: `forge build` and compare
      the artifact's `bytecode.object` against the pre-change build.

12. **Remind user to update Product Target Sheet**:

    - Display a prominent reminder to manually update the Product Target State spreadsheet
    - The spreadsheet tracks contract deployments across networks: https://docs.google.com/spreadsheets/d/1jX1wfFkSn1s19I_KzMA7vB1kfgGxXUv7kRqwUGJJLF4/edit#gid=0
    - For deprecated networks: Move the network row(s) to the deprecated section
    - This is a manual step that must be done separately as the spreadsheet is not part of the codebase

13. **Review remaining occurrences**:

    - Re-run the step 8 grep and present everything still matching, grouped by file path
      and sorted alphabetically. For each file show the path, the match count, and the
      first 2-3 matching lines with line numbers.
    - Classify each hit before presenting it:
      - **Intentional keeps** (do not offer for deletion):
        `deployments/_deployments_log_file.json`, `archive/**`, and the facet chainId
        mappings from step 11.
      - **Needs a decision**: example strings in script help text / `usage` blocks
        (#2222 had to swap `moonbeam` out of a `--networks` example in
        `script/tasks/unpauseAllDiamonds.ts`), commented-out network arrays in shell
        scripts (#2004 had to edit two in `script/multiNetworkExecution.sh`), and test fixtures.
    - Ask the user which of the "needs a decision" hits to clean up, and wait for input
      before removing anything further.

14. **Display summary**:

    - List all networks successfully deprecated
    - List all files modified and removed
    - List the intentional keeps explicitly, so a reviewer can see they were considered
    - List any warnings (e.g., network not found in networks.json, but found in foundry.toml)
    - Display any errors encountered

## File Patterns

### Deployment Log Files to Remove

For a network named `fantom`, remove:

- `deployments/fantom.json`
- `deployments/fantom.staging.json`
- `deployments/fantom.diamond.json`
- `deployments/fantom.diamond.staging.json`

### Foundry.toml Entries to Remove

**RPC Endpoints section** (`[rpc_endpoints]`):

```toml
fantom = "${ETH_NODE_URI_FANTOM}"
```

**Etherscan section** (`[etherscan]`):

```toml
fantom = { key = "${MAINNET_ETHERSCAN_API_KEY}", url = "https://api.etherscan.io/v2/api?chainid=250", chain = "250" }
```

### Target State File to Remove

**Target State file** (`script/deploy/_targetState.json`):

```json
{
  "fantom": {
    "production": { ... },
    "staging": { ... }
  }
}
```

The entire `"fantom"` entry (including both production and staging) will be removed.

### Whitelist Blocks to Remove

**Whitelist file** (`config/whitelist.json`), removed by hand — never by the generator:

```json
  "PERIPHERY": {
    "fantom": [ ... ]
  }
```

```json
  "DEXS": [
    {
      "contracts": {
        "fantom": [ ... ]
      }
    }
  ]
```

`PERIPHERY.fantom` sits at 4-space indent, `DEXS[].contracts.fantom` at 8-space, and the
latter recurs under every DEX that covers the network.

### Files to Preserve

Never removed for a deprecated network:

- `deployments/_deployments_log_file.json` — the master deployment log (history, not state)
- `archive/config/*` — historical integration configs
- `config/whitelist.staging.json` — gitignored; must not appear in the diff
- Hardcoded chainId mappings in `src/Facets/` — commented, not deleted (see execution step 11)

## Validation Checklist

Before executing, validate:

- [ ] **Network exists**: Verify network exists in `config/networks.json` (warn if not found, but continue)
- [ ] **Network name format**: Network names should match exactly (case-sensitive) as they appear in `config/networks.json`
- [ ] **Multiple networks**: Support space-separated list of networks
- [ ] **File existence**: Check if deployment files exist before attempting deletion (not an error if missing)
- [ ] **JSON formatting**: Preserve proper JSON formatting when removing from `config/networks.json`
- [ ] **TOML formatting**: Preserve proper TOML formatting and comments when removing from `foundry.toml`

After executing, validate:

- [ ] **Whitelist diff is deletions-only**: `git diff --numstat config/whitelist.json` shows 0 additions
- [ ] **Staging whitelist untouched**: `config/whitelist.staging.json` is absent from `git status`
- [ ] **Master log intact**: `deployments/_deployments_log_file.json` is absent from `git status`
- [ ] **Health-check test passes**: `bun test:ts` — covers `every exempt network is a known network`
- [ ] **Facet bytecode unchanged**: if a `src/Facets/` file was touched, the change is comment-only

## Error Handling

The command handles:

- Networks not found in `config/networks.json` (warn but continue)
- Networks not found in `foundry.toml` (warn but continue)
- Networks not found in `script/deploy/_targetState.json` (skip silently, not an error)
- Deployment files that don't exist (skip silently)
- Invalid JSON structure (error and abort)
- Invalid TOML structure (error and abort)
- File system errors (error and report)
- Partial failures (continue with remaining networks, report all errors at end)
- Network absent from an integration config or from `CORE_FACET_EXEMPTIONS` (skip silently, not an error)
- Network absent from `config/whitelist.json` (skip silently — not every network has DEX or periphery entries)
- A non-empty additions count on `config/whitelist.json` (abort: the generator ran, or blocks were rewritten instead of removed)
- Remaining occurrences search: Exclude generated directories, group by file, show context
- User review of remaining occurrences: Wait for user input before removing additional files

## Safety Features

- **Dry-run option**: Consider showing what would be removed before actually removing (optional enhancement)
- **Confirmation**: For multiple networks, display summary before proceeding
- **Backup suggestion**: Recommend backing up files before deprecation (informational message)
- **Remaining occurrences review**: After deprecation, search codebase and present all matches for user review before removing

## Manual Steps Required

After the command completes, you **must** manually update the Product Target State spreadsheet:

- **Spreadsheet URL**: https://docs.google.com/spreadsheets/d/1jX1wfFkSn1s19I_KzMA7vB1kfgGxXUv7kRqwUGJJLF4/edit#gid=0
- **For deprecated networks**: Move the network row(s) to the deprecated section in the spreadsheet
- This spreadsheet tracks contract deployments across all networks and is used by the product team
- The command cannot automatically update this spreadsheet as it's external to the codebase

## Key Files Modified

- `config/networks.json` - Network configuration (removes network entries)
- `foundry.toml` - Foundry configuration (removes RPC and etherscan entries)
- `script/deploy/_targetState.json` - Target state configuration (removes network entries for both production and staging)
- `deployments/{network}*.json` - Per-network deployment log files (deletes matching files)
- `config/*.json` - Bridge/integration configs, discovered by grep (removes network entries)
- `script/deploy/healthCheckInvariants.ts` - Removes the network from `CORE_FACET_EXEMPTIONS`
- `config/whitelist.json` - Hand-edited: removes `PERIPHERY.{network}` and `DEXS[].contracts.{network}`
- `src/Facets/*.sol` - Comment-only, when a hardcoded chainId mapping covers the network

## Implementation Notes

- Use exact string matching for network names (case-sensitive)
- Preserve file formatting when editing JSON and TOML files
- Handle edge cases like networks that exist in one file but not others
- Support deprecating multiple networks in a single command
- Display clear, actionable error messages if something goes wrong
- After completion, verify changes by checking that entries are actually removed
- Drive the config cleanup from a repo-wide grep, not from a hardcoded file list — the set of
  integration configs grows every time an integration is added
- Edit `config/whitelist.json` by hand; the generator is out of sync with the committed file and
  its output would swamp the diff
- After all deprecation steps, search the entire codebase for remaining occurrences of the network name
- Present a concise, organized list of matches grouped by file with line numbers and context
- Separate intentional keeps (master log, `archive/**`, facet chainId mappings) from hits that need
  a decision, and only ask the user about the latter

## Example Output

```text
Deprecating networks: fantom, harmony

✓ Removed 'fantom' from config/networks.json
✓ Removed 'harmony' from config/networks.json
✓ Removed RPC endpoint + etherscan entry for 'fantom' from foundry.toml
✓ Removed RPC endpoint + etherscan entry for 'harmony' from foundry.toml
✓ Removed 'fantom' from script/deploy/_targetState.json
✓ Removed 'harmony' from script/deploy/_targetState.json
✓ Deleted deployments/fantom.json, deployments/fantom.diamond.json
✓ Deleted deployments/harmony.json, deployments/harmony.diamond.json

⚠ Warning: deployments/fantom.staging.json not found (skipped)
⚠ Warning: deployments/harmony.staging.json not found (skipped)

Integration configs (from repo-wide grep):
✓ Removed 'fantom' from config/gaszip.json, config/permit2Proxy.json, config/squid.json
✓ Removed 'harmony' from config/relay.json

✓ Removed 'fantom' from CORE_FACET_EXEMPTIONS in script/deploy/healthCheckInvariants.ts
✓ bun test:ts — 'every exempt network is a known network' passes

Whitelist (hand-edited, generator NOT run):
✓ Removed PERIPHERY.fantom
✓ Removed 4 DEXS[].contracts.fantom blocks
✓ git diff --numstat config/whitelist.json → 0 additions, 106 deletions
✓ config/whitelist.staging.json untouched (gitignored)

Facet chainId mappings:
⚠ src/Facets/AcrossV4SwapFacet.sol has a chainId → LayerZero eid entry for fantom
  → entry KEPT, comment added marking it for removal on next facet modification
  → comment-only change: bytecode unchanged, no version bump or re-audit needed

Preserved (historical records, intentionally not modified):
• deployments/_deployments_log_file.json
• archive/config/*

Successfully deprecated 2 networks.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  MANUAL STEP REQUIRED: Update Product Target Sheet
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Please manually update the Product Target State spreadsheet:
📊 https://docs.google.com/spreadsheets/d/1jX1wfFkSn1s19I_KzMA7vB1kfgGxXUv7kRqwUGJJLF4/edit#gid=0

Actions required:
- Move the "fantom" row to the deprecated section
- Move the "harmony" row to the deprecated section

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Remaining Occurrences Review
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Needs a decision:

  📄 script/tasks/unpauseAllDiamonds.ts
     Line 41: Example: --networks gnosis,fantom,rootstock
     → example string in help text; suggest swapping for an active network

  📄 script/multiNetworkExecution.sh
     Line 2586: # local NETWORKS=("arbitrum" "aurora" ... "fantom" ...)
     → commented-out network array

Intentional keeps (no action):

  📄 deployments/_deployments_log_file.json — 27 matches (master log, history)
  📄 archive/config/hyphen.json — 1 match (archived integration config)
  📄 src/Facets/AcrossV4SwapFacet.sol — 1 match (chainId mapping, comment added above)

Please indicate which of the "needs a decision" hits to clean up:
- Type the file paths you want to clean up
- Or say "none" if all occurrences should remain
```
