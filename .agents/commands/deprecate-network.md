---
name: deprecate-network
description: "Removes one or more networks from the codebase — networks.json, foundry.toml, target state, deploy logs, integration configs, health-check exemptions, whitelist — and cancels their queued diamond-cleanup tasks. Use for \"deprecate <network>\". Keeps the master log and facet chainId mappings."
usage: /deprecate-network <network1> [network2] [network3] ...
---

# Deprecate Network

> **Usage**: `/deprecate-network <network1> [network2] ...` (e.g. `/deprecate-network fantom harmony evmos`)

Network names match `config/networks.json` exactly (case-sensitive). On a partial failure,
continue with the remaining networks and report all errors at the end. Invalid JSON/TOML
structure → abort.

## Steps

1. **Validate network names** against `config/networks.json`. Warn on a missing network
   but continue with the others. Display the networks to be deprecated and wait for
   explicit go-ahead — also for a single network, because step 2 writes to MongoDB before
   any PR review.

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
     Run it once per network; `--cancel-deprecated` refuses to run fleet-wide on
     purpose, so a temporarily narrowed `networks.json` can never cancel the whole queue.
     Run it without `--yes` first, show the user the tasks it would cancel, and add
     `--yes` only after they approve that list — a cancelled task does not come back if
     the deprecation PR is later rejected.
   - A `proposed` task is **not** cancelled by that command: its Safe removal proposal is
     already live and `markCancelled` accepts `queued` only, so cancelling it would cut
     the proposal from its origin-PR linkage. It needs `revertToQueued` first, for which
     there is no operator CLI yet (EXSC-715) — surface it to the SC on-call rather than
     editing Mongo by hand.
   - If a task will not transition, **abort the deprecation for that network** and report
     its `taskKey`. Removing the config first and failing here strands the task
     permanently — the weekly cron then reports (never cancels) it as sitting on a
     non-active network every run.

3. **`config/networks.json`**: remove the whole network object, preserving formatting.

4. **`foundry.toml`**: remove the network's line under `[rpc_endpoints]`
   (`fantom = "${ETH_NODE_URI_FANTOM}"`) and its entry under `[etherscan]`
   (`fantom = { key = "...", url = "...", chain = "250" }`, may span multiple lines).
   Preserve formatting and comments; warn and continue if absent.

5. **`script/deploy/_targetState.json`**: `jq 'del(.["{network}"])'` — removes both
   production and staging. Skip silently if absent.

6. **Deployment logs**: delete `deployments/{network}.json`, `{network}.staging.json`,
   `{network}.diamond.json`, `{network}.diamond.staging.json`. A missing file is a
   warning, not an error — process the rest. Do **not** touch
   `deployments/_deployments_log_file.json` (step 11).

7. **Scrub the bridge/integration configs**:

   - Most `config/*.json` files carry per-network entries (seen in #2004, #2141, #2222:
     `gaszip`, `permit2Proxy`, `squid`, `stargateV2`, `relay`, `glacis`, `garden`,
     `layerswap`, `symbiosis`). **Do not work from that list** — it grows with every
     integration. Drive this step from `git grep -inw "<network>"` (tracked files only,
     covers `.agents/`, `.github/`, `docs/`, root files).
   - `-w` drops siblings that extend the name (`tron` no longer reports `tronshasta`)
     but **not** one separated by a non-word character (`taiko` still matches
     `eth-taiko`). Treat every hit as a candidate: parse the config's keys and require an
     *exact* match with the canonical network name before deleting.
   - Keys are usually `"<network>": <value>`, but some files nest the network under a
     per-integration object — check the structure before deleting.
   - Report hits outside `config/` (scripts, docs, comments) in the step 13 review rather
     than deleting them silently.

8. **`CORE_FACET_EXEMPTIONS` and `CORE_PERIPHERY_EXEMPTIONS`** in
   `script/deploy/healthCheckInvariants.ts`: delete the network from every exemption's
   `networks` array; remove an exemption whose array becomes empty. CI-enforced —
   `healthCheckInvariants.test.ts` (`every exempt network is a known network`) fails on
   a leftover entry. Verify with `bun test:ts`.

9. **Whitelist — by hand, surgically**:

    - **Do NOT use `bun update-whitelist-periphery` as the removal mechanism.**
      It regenerates the `PERIPHERY` section for *every* network from the current
      deployment logs, so whatever drift has accumulated since the last periphery
      redeploy lands in the deprecation diff and makes it unreviewable.
    - Hand-remove exactly two kinds of block from `config/whitelist.json`:
      the `PERIPHERY.<network>` key (4-space indent), and every
      `DEXS[].contracts.<network>` key (8-space indent) — a network typically appears
      under several DEXs.
    - Verify it still parses and only the target keys went:

      ```bash
      # before editing
      jq -r '[(.PERIPHERY|keys[]), (.DEXS[]|.contracts|keys[])] | unique | .[]' \
        config/whitelist.json > /tmp/wl-keys.before

      jq empty config/whitelist.json           # must exit 0 — file is still valid JSON
      jq -r '[(.PERIPHERY|keys[]), (.DEXS[]|.contracts|keys[])] | unique | .[]' \
        config/whitelist.json | diff /tmp/wl-keys.before -
      ```

      The key diff must show one `<` line per deprecated network and nothing else — or
      nothing at all, for a network that had no whitelist entry
      (`localanvil` and `tronshasta` are in `networks.json` but not the whitelist).
      Do not substitute `git diff --numstat`: it proves only that nothing was *added*,
      and removing the last key of an object also rewrites the preceding line's comma.
      A malformed file or an extra removed key → abort and restore the file.

    - **Leave `config/whitelist.staging.json` alone.** The generator rewrites it
      unconditionally whichever environment you target, and it is gitignored, so
      `git status` cannot prove it was untouched. Checksum it instead:

      ```bash
      shasum config/whitelist.staging.json > /tmp/staging-whitelist.before
      # ... run the deprecation ...
      shasum -c /tmp/staging-whitelist.before   # must report OK
      ```

10. **ChainId mappings inside facets** (`src/Facets/`): some facets hardcode
    `chainId -> LayerZero eid` or `chainId -> CCTP domain` (e.g. `AcrossV4SwapFacet.sol`).
    **Do not remove the entry** — the mapping describes the bridge's coverage, not
    LI.FI's. **Do not edit the facet source at all — not even a comment**: the compiler
    embeds an IPFS hash of the source metadata (Foundry's default `bytecode_hash`), so any
    change alters the bytecode, the CREATE3 deploy salt (and the next predicted address of
    that version), breaks exact source match of deployed instances on explorers, and forces
    a `buildAttestations.json` re-mint. List the kept entry in the PR body (facet, chainId,
    why the bridge still needs it).

11. **Preserve historical records**: `deployments/_deployments_log_file.json` (the
    deployment history across all networks — #2004 and #2141 deliberately kept deprecated
    records) and `archive/config/*`. The step 7 search hits both; report them as
    intentional keeps, not cleanup candidates.

12. **Summary**: networks deprecated, files removed/edited, records deliberately preserved
    (master log, `archive/**`, facet chainId mappings), warnings, errors. Then show the
    manual reminder: move the network row(s) to the deprecated section of the Product
    Target State spreadsheet —
    <https://docs.google.com/spreadsheets/d/1jX1wfFkSn1s19I_KzMA7vB1kfgGxXUv7kRqwUGJJLF4/edit#gid=0>.

13. **Remaining occurrences review**: re-run `git grep -inw "<network>"` per network (same
    `-w` caveat as step 7). Group by file path, alphabetically, with match count and the
    first 2–3 matching lines; label deliberate keeps (master log, `archive/`, facet
    mappings, test fixtures). Ask the user which to remove — file paths, `none`, `all`, or
    `config only` (excluding `archive/`) — and wait before any further removal.
