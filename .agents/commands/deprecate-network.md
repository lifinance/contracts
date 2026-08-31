---
name: deprecate-network
description: Deprecate one or more networks — scrub networks.json, foundry.toml, target state, bridge/integration configs, CORE_FACET_EXEMPTIONS, the whitelist and per-network deploy logs, while preserving the master log and facet chainId mappings
usage: /deprecate-network <network1> [network2] [network3] ...
---

# Deprecate Network Command

> **Usage**: `/deprecate-network <network1> [network2] [network3] ...`

## Overview

This command completely removes a network (or multiple networks) from the codebase by:

1. Flipping the network's `status` to `inactive` in `config/networks.json`, then cancelling its `queued` tasks in the deferred diamond-cleanup queue while the config they depend on still exists (a `proposed` task is reported, never cancelled — it may have a live Safe proposal)
2. Removing the network entry from `config/networks.json`
3. Removing the RPC endpoint entry from `foundry.toml` under `[rpc_endpoints]`
4. Removing the etherscan entry from `foundry.toml` under `[etherscan]`
5. Removing the network entry from `script/deploy/_targetState.json` (removes both production and staging environments)
6. Removing all deployment log files in `deployments/` directory that match the network name pattern
7. Removing the network from every bridge/integration config under `config/` that carries a per-network entry
8. Removing the network from `CORE_FACET_EXEMPTIONS` in `script/deploy/healthCheckInvariants.ts`
9. Hand-removing the network's blocks from `config/whitelist.json` (not via the generator)
10. Marking — not removing — the network in any hardcoded chainId mapping under `src/Facets/`

The master deployment log (`deployments/_deployments_log_file.json`) and `archive/config/*`
are **preserved**: they are historical records, not a list of active networks.

## How to Use

1. Type `/deprecate-network` followed by one or more network names (space-separated)
2. The command will automatically:
   - Validate that the networks exist in `config/networks.json`
   - Flip the network's `status` to `inactive`, then cancel its `queued` parked diamond-cleanup tasks (reporting any `proposed` one) — both before anything is removed
   - Remove network entries from `config/networks.json`
   - Remove RPC endpoint entries from `foundry.toml`
   - Remove etherscan entries from `foundry.toml`
   - Remove network entries from `script/deploy/_targetState.json`
   - Delete all deployment log files matching the network pattern
   - Remove the network's entry from every bridge/integration config that carries one
   - Remove the network from `CORE_FACET_EXEMPTIONS`
   - Hand-remove the network's `PERIPHERY` and `DEXS[].contracts` blocks from `config/whitelist.json`
   - Flag any hardcoded chainId mapping in `src/Facets/` for a comment instead of a deletion
   - Display a summary of all changes made, including the records deliberately preserved

## Examples

### Deprecate a single network:

```
/deprecate-network fantom
```

### Deprecate multiple networks:

```
/deprecate-network fantom harmony evmos
```

## Execution Steps

When `/deprecate-network` is invoked with network names:

1. **Validate network names**:

   - Read `config/networks.json` to verify all specified networks exist
   - If a network doesn't exist, warn the user but continue with other networks
   - Display list of networks to be deprecated for confirmation

2. **Cancel open parked diamond-cleanup tasks** (before anything destructive):

   **Precondition — the network's `status` in `config/networks.json` must not be
   `active` any more.** `--cancel-deprecated` decides what is deprecated by reading
   that file, so with the entry still `active` its tasks are routed to the loupe
   instead of the cancellation path and the command is a silent no-op. Set the entry
   to `"status": "inactive"` before running it — the entry itself is only removed in
   step 3, so the RPC and deploy logs the reconcile reads are still there. Verify:
   `jq -r '."{network}".status // "absent"' config/networks.json`
   — it must print anything other than `active`.

   - List the network's open tasks:
     `bunx tsx script/deploy/safe/list-parked-tasks.ts --network {network} --status queued`
     (repeat with `--status proposed`)
   - A facet removal parked for a network that is going away can never be drained — the
     reconcile cannot reach a chain `config/networks.json` no longer describes — so
     cancel the `queued` ones:
     `bunx tsx script/deploy/safe/reconcile-parked-tasks.ts --network {network} --cancel-deprecated --yes`
     Run it **once per network**; `--cancel-deprecated` refuses to run fleet-wide on
     purpose, so a temporarily narrowed `networks.json` can never cancel the whole queue.
     Drop `--yes` first to preview.
   - A `proposed` task is **not** cancelled by that command: its Safe removal proposal is
     already live and `markCancelled` accepts `queued` only, so cancelling it would cut
     the proposal from its origin-PR linkage. It needs `revertToQueued` first, for which
     there is no operator CLI yet (EXSC-715) — surface it to the SC on-call rather than
     editing Mongo by hand.
   - If a task will not transition, **abort the deprecation for that network** and report
     its `taskKey`. Removing the config first and failing here strands the task
     permanently — the weekly cron then reports (never cancels) it as sitting on a
     non-active network every run.

3. **Remove from `config/networks.json`**:

   - Read the JSON file
   - For each network, remove the entire network object (e.g., `"fantom": { ... }`)
   - Write the updated JSON back to the file
   - Preserve JSON formatting and indentation

4. **Remove from `foundry.toml` - RPC endpoints**:

   - Read `foundry.toml`
   - Locate the `[rpc_endpoints]` section
   - For each network, remove the line: `{network} = "${ETH_NODE_URI_{NETWORK}}"` (case-insensitive matching)
   - Preserve TOML formatting and comments

5. **Remove from `foundry.toml` - Etherscan**:

   - Locate the `[etherscan]` section
   - For each network, remove the entire etherscan entry block:

     ```toml
     {network} = { key = "...", url = "...", chain = "..." }
     ```

   - Handle entries that may span multiple lines
   - Preserve TOML formatting and comments

6. **Remove from `script/deploy/_targetState.json`**:

   - Read the target state JSON file
   - For each network, remove the entire network entry (e.g., `"fantom": { ... }`)
   - This removes both production and staging environments for the network
   - Use `jq` to remove the network: `jq 'del(.["{network}"])'` or equivalent
   - Write the updated JSON back to the file
   - Preserve JSON formatting and indentation
   - If the network doesn't exist in target state, skip silently (not an error)

7. **Remove deployment log files**:

   - For each network, delete all files in `deployments/` directory matching:
     - `{network}.json`
     - `{network}.staging.json`
     - `{network}.diamond.json`
     - `{network}.diamond.staging.json`
   - Use case-insensitive matching for network names
   - If a file doesn't exist, warn and continue — a missing log is not an error, and the
     remaining files must still be processed
   - **Do NOT touch `deployments/_deployments_log_file.json`** — see step 12

8. **Scrub the bridge/integration configs**:

   - Beyond `config/networks.json`, most `config/*.json` files carry per-network entries
     for a specific bridge or integration, and every real deprecation has had to clean
     them. Observed across #2004, #2141 and #2222: `config/gaszip.json`,
     `config/permit2Proxy.json`, `config/squid.json`, `config/stargateV2.json`,
     `config/relay.json`, `config/glacis.json`, `config/garden.json`,
     `config/layerswap.json`, `config/symbiosis.json`.
   - **Do not work from that list** — it grows every time an integration is added.
     Drive this step from a repo-wide search instead:

     ```bash
     git grep -inw "<network>"
     ```

     `git grep` covers every tracked file — including `.agents/`, `.github/`, `docs/` and
     root files like `foundry.toml` — and respects `.gitignore`, so generated directories
     need no exclude list. `-w` drops siblings that merely extend the name: deprecating
     `tron` no longer reports `tronshasta`. It does **not** drop a sibling separated by a
     non-word character — `-w` still matches `taiko` inside `eth-taiko` — so `-w` narrows
     the candidate set, it does not make a hit safe to delete.
   - **Treat every hit as a candidate, never as a deletion target.** Before editing an
     integration config, parse its keys and require an *exact* match with the canonical
     network name. A substring match on a sibling network must not be removed.
   - Remove the network's entry from every integration config that has one. Keys are
     usually a plain `"<network>": <value>` pair, but some files nest the network under
     a per-integration object — check the surrounding structure before deleting.
   - Report anything the search surfaces outside `config/` (scripts, docs, comments) in
     the step 15 review rather than deleting it silently.

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

    - **Do NOT reach for `bun update-whitelist-periphery` as the removal mechanism.**
      It regenerates the `PERIPHERY` section for *every* network from the current
      deployment logs, so whatever drift has accumulated since the last periphery
      redeploy lands in the deprecation diff alongside the removal and makes it
      unreviewable. That drift is zero right after a whitelist sync and grows with
      each redeploy, so its size is not predictable at deprecation time — measure it
      with `git diff --numstat config/whitelist.json` if you want to know, but remove
      the network by hand either way.
    - Instead, hand-remove exactly two kinds of block from `config/whitelist.json`:
      - the `PERIPHERY.<network>` key (4-space indent), and
      - every `DEXS[].contracts.<network>` key (8-space indent) — a network typically
        appears under several DEXs, so remove all of them.
    - Hand-editing JSON can leave the file malformed in ways a diff will not show, so
      verify both that it still parses and that the change is deletions-only:

      ```bash
      jq empty config/whitelist.json          # must exit 0 — file is still valid JSON
      git diff --numstat config/whitelist.json # additions column must be 0
      ```

    - **Leave `config/whitelist.staging.json` alone** — and note that the generator
      rewrites it unconditionally, whichever environment you target. It is gitignored,
      so `git status` will never show it as modified and cannot be used to prove it
      was left alone. Checksum it before and after instead:

      ```bash
      shasum config/whitelist.staging.json > /tmp/staging-whitelist.before
      # ... run the deprecation ...
      shasum -c /tmp/staging-whitelist.before   # must report OK
      ```

11. **Handle chainId mappings inside facets** (`src/Facets/`):

    - Some facets carry hardcoded `chainId -> LayerZero eid` or `chainId -> CCTP domain`
      mappings (e.g. `AcrossV4SwapFacet.sol`). If the deprecated network appears in one,
      **do not remove the entry** — the underlying bridge may still support that chain,
      and the mapping describes the bridge's coverage, not LI.FI's.
    - Add a comment above the entry marking it for removal on the next modification of
      the facet. A comment-only change leaves the compiled bytecode identical, so it
      triggers neither a contract version bump nor a re-audit.
    - Wording template — substitute the actual network name and deprecation ticket before
      writing it; the placeholders below are not literal text (see the Taiko entry added
      in #2141 and the Moonbeam entry added in #2222, both in
      `src/Facets/AcrossV4SwapFacet.sol`):

      ```solidity
      // <Network> is no longer supported by LI.FI (deprecated in <TICKET>); Across still supports it.
      // Remove this entry the next time this facet is modified.
      if (_chainId == <chainId>) return <value>; // <Network>
      ```

    - Confirm bytecode really is unchanged before claiming it: `forge build` and compare
      the artifact's `bytecode.object` against the pre-change build.

12. **Preserve the historical records** (do not delete):

    - `deployments/_deployments_log_file.json` (the master log) keeps the deprecated
      network's records. It is the deployment history across all networks and is not
      scoped to the currently-active set; removing entries destroys the audit trail of
      what was deployed where. Both #2004 (corn) and #2141 (taiko et al.) deliberately
      left the deprecated networks' records in place.
    - `archive/config/*` is historical by definition — leave every deprecated-network
      value there untouched.
    - This is easy to get wrong in the opposite direction: the step 8 search will hit
      both of these, and they must be reported as intentional keeps, not offered as
      cleanup candidates.

13. **Remind user to update Product Target Sheet**:

   - Display a prominent reminder to manually update the Product Target State spreadsheet
   - The spreadsheet tracks contract deployments across networks: https://docs.google.com/spreadsheets/d/1jX1wfFkSn1s19I_KzMA7vB1kfgGxXUv7kRqwUGJJLF4/edit#gid=0
   - For deprecated networks: Move the network row(s) to the deprecated section
   - This is a manual step that must be done separately as the spreadsheet is not part of the codebase

14. **Display summary**:

    - List all networks successfully deprecated
    - List all files removed
    - List the records deliberately preserved (master deployment log, `archive/**`, facet chainId mappings)
    - List any warnings (e.g., network not found in networks.json, but found in foundry.toml)
    - Display any errors encountered

15. **Search for remaining occurrences**:

- For each deprecated network, re-run the step 8 search over every tracked file:
  `git grep -inw "<network>"`
- `-w` is required, not optional: a bare substring search reports `tronshasta` when
  deprecating `tron`, and those false positives are exactly what drives a wrong deletion
  in this review step. It is a filter, not a guarantee — a hyphen-separated sibling such
  as `eth-taiko` still matches, so the exact-key check from step 8 still applies here
- `git grep` needs no exclude list — it searches tracked files only, so generated
  directories are already out of scope, and it covers `.agents/`, `.github/`, `docs/`
  and root files that a path-scoped `grep` would miss
- Group results by file path, sorted alphabetically
- For each file, show:
  - File path (relative to workspace root)
  - Total number of matches in that file
  - Sample of matches (first 2-3 lines with line numbers and context)
- Present a concise, organized list to the user with clear formatting
- **Important notes**:
  - Some files like `config/*.json` may intentionally keep network values for historical reference
  - Files in `archive/` directory are typically historical and may be kept
  - Test files may reference networks for testing purposes
- Ask the user to review the list and indicate which files/occurrences should be removed
- Wait for user input before proceeding with any additional removals
- Format options for user response:
  - List specific file paths to clean up
  - Say "none" if all occurrences should remain
  - Say "all" to remove all occurrences (use with caution)
  - Say "config only" to remove only from config files (excluding archive/)

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

## Validation Checklist

Before executing, validate:

- [ ] **Network exists**: Verify network exists in `config/networks.json` (warn if not found, but continue)
- [ ] **Status flipped before cancelling**: `config/networks.json` shows the network as non-`active` — `--cancel-deprecated` is a silent no-op while it is still `active`
- [ ] **Network name format**: Network names should match exactly (case-sensitive) as they appear in `config/networks.json`
- [ ] **Multiple networks**: Support space-separated list of networks
- [ ] **File existence**: Check if deployment files exist before attempting deletion (not an error if missing)
- [ ] **JSON formatting**: Preserve proper JSON formatting when removing from `config/networks.json`
- [ ] **TOML formatting**: Preserve proper TOML formatting and comments when removing from `foundry.toml`

## Error Handling

The command handles:

- Networks not found in `config/networks.json` (warn but continue)
- Networks not found in `foundry.toml` (warn but continue)
- Networks not found in `script/deploy/_targetState.json` (skip silently, not an error)
- Deployment files that don't exist (warn and continue, then process the remaining files)
- Invalid JSON structure (error and abort)
- Invalid TOML structure (error and abort)
- File system errors (error and report)
- Partial failures (continue with remaining networks, report all errors at end)
- Malformed `config/whitelist.json` after hand-editing, or a non-zero additions column in `git diff --numstat` (error and abort - the file must be restored before continuing)
- Remaining occurrences search: `git grep -inw` over tracked files only, group by file, show context
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
- `deployments/{network}*.json` - Deployment log files (deletes matching files)
- `deferred-cleanup.parkedTasks` (MongoDB) - Parked diamond-cleanup tasks (cancels the network's `queued` ones only)
- `config/*.json` (bridge/integration configs) - Per-network entries, found by search rather than from a fixed list
- `script/deploy/healthCheckInvariants.ts` - `CORE_FACET_EXEMPTIONS` (CI-enforced; a stale entry fails `bun test:ts`)
- `config/whitelist.json` - Hand-edited, deletions only; **never** regenerated
- `src/Facets/*.sol` - Hardcoded chainId mappings get a marker comment, not a deletion

**Not modified** (historical records): `deployments/_deployments_log_file.json`, `archive/config/*`,
`config/whitelist.staging.json`.

## Implementation Notes

- Use exact string matching for network names (case-sensitive)
- Preserve file formatting when editing JSON and TOML files
- Handle edge cases like networks that exist in one file but not others
- Support deprecating multiple networks in a single command
- Display clear, actionable error messages if something goes wrong
- After completion, verify changes by checking that entries are actually removed
- Edit `config/whitelist.json` by hand and verify the result with `jq empty` plus a
  deletions-only `git diff --numstat`; never regenerate it during a deprecation
- After all deprecation steps, search every tracked file for remaining occurrences of the
  network name with `git grep -inw` — whole-word, so sibling networks are not reported
- Present a concise, organized list of matches grouped by file with line numbers and context
- Ask the user to review and indicate which files/occurrences should be removed
- Some config files (e.g., `config/*.json`) may intentionally keep network values for historical reference - let user decide

## Example Output

```
Deprecating networks: fantom, harmony

✓ Removed 'fantom' from config/networks.json
✓ Removed 'harmony' from config/networks.json
✓ Removed RPC endpoint for 'fantom' from foundry.toml
✓ Removed RPC endpoint for 'harmony' from foundry.toml
✓ Removed etherscan entry for 'fantom' from foundry.toml
✓ Removed etherscan entry for 'harmony' from foundry.toml
✓ Removed 'fantom' from script/deploy/_targetState.json
✓ Removed 'harmony' from script/deploy/_targetState.json
✓ Deleted deployments/fantom.json
✓ Deleted deployments/fantom.diamond.json
✓ Deleted deployments/harmony.json
✓ Deleted deployments/harmony.diamond.json

⚠ Warning: deployments/fantom.staging.json not found (skipped)
⚠ Warning: deployments/harmony.staging.json not found (skipped)

✓ Removed 'fantom' from config/gaszip.json, config/relay.json
✓ Removed 'harmony' from config/gaszip.json
✓ Removed 'fantom', 'harmony' from CORE_FACET_EXEMPTIONS
✓ Hand-removed whitelist blocks (PERIPHERY + 3 DEXS entries) — jq empty OK, 0 additions
✓ config/whitelist.staging.json checksum unchanged

Preserved (historical, not cleanup candidates):
  · deployments/_deployments_log_file.json — 41 records for fantom, 12 for harmony
  · archive/config/* — left untouched

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

Found additional occurrences of deprecated networks in the codebase:

Network: fantom
  📄 config/whitelist.json
     Line 211: "aurora": [...]
     Line 1880: "fantom": [...]

  📄 config/permit2Proxy.json
     Line 6: "fantom": "0x000000000022D473030F116dDEE9F6B43aC78BA3"

  📄 config/gaszip.json
     Line 9: "fantom": "0x2a37D63EAdFe4b4682a3c28C1c2cD4F109Cc2762"

  📄 script/multiNetworkExecution.sh
     Line 2586: # local NETWORKS=("arbitrum" "aurora" "base" "blast" "bob" "bsc" "cronos" "gravity" "linea" "mainnet" "mantle" "mode" "polygon" "scroll" "taiko")

Network: harmony
  📄 config/whitelist.json
     Line 704: "harmony": [...]

  📄 deployments/harmony.json
     Line 1: { "DiamondCutFacet": "0x..." }

⚠️  Note: Some config files (e.g., config/*.json) may intentionally keep network values for historical reference.

Please review the above list and indicate which files/occurrences should be removed:
- Type the file paths you want to clean up
- Or say "none" if all occurrences should remain
- Or say "all" to remove all occurrences (use with caution)
```
