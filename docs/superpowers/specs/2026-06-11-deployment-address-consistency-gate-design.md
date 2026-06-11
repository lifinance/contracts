# Deployment Address Consistency Gate — Design

**Date:** 2026-06-11
**Status:** Approved (pending spec review)
**Author:** Michal Mironczuk

## Problem

A contract's address is recorded in up to three committed files per network:

- `config/whitelist.json` — `.PERIPHERY[<network>][] { name, address }` (periphery only; top-level keys are `DEXS` and `PERIPHERY`)
- `deployments/<network>.json` — flat `{ ContractName: address }` (all contracts: facets, periphery, diamond, timelock, …)
- `deployments/<network>.diamond.json` — `.LiFiDiamond.Periphery { Name: address }` and `.LiFiDiamond.Facets { address: { Name, Version } }`

These are edited by hand and by deploy tooling, and nothing checks that the same
contract carries the same address across them. PR #1890 shipped an OutputValidator
whose `optimismsepolia` whitelist address (`0x293BEf…`) did not match the deployed
address in the deployment logs (`0x1581cA9…`); the orphan address appeared in no
deployment file at all. Result: the live contract would not be whitelisted and a
phantom address would be. The mismatch was caught only in review.

## Goal

Block a commit that introduces an address mismatch between these files, for both
humans and agents, with a clear report of every conflict.

## Non-Goals

- No on-chain / RPC verification (that already lives in `script/deploy/healthCheck.ts`).
- No CI gate and no Claude-specific PreToolUse gate (explicitly out of scope per
  the placement decision; husky pre-commit only).
- No validation of the `DEXS` whitelist section (those are external router
  addresses, not LI.FI deployments).

## Invariant

For each network, a contract's address must **agree across every file that lists it**,
ignoring empty-string (`""`) placeholders and entries absent from a given file
("agree where present"). All address comparisons are case-insensitive.

Two sub-checks, each driven off the **structured** sources so the flat
`deployments/<network>.json` is only ever used as a name→address lookup table (we
never have to classify whether a flat-file name is a facet or periphery):

### A. Periphery — three-way

- Candidate names = keys of `whitelist.PERIPHERY[<network>]` ∪ keys of
  `diamond.json.LiFiDiamond.Periphery` (skipping `""` values).
- For each name, collect its non-empty address from each of the three sources that
  has it. If two or more sources have a non-empty address, all must be equal.

### B. Facets — two-way (facets are not whitelisted)

- Candidate names = the `Name` field of each entry in
  `diamond.json.LiFiDiamond.Facets` (which is keyed by address), inverted to
  `{ Name: address }`.
- Compare each against `deployments/<network>.json[Name]`. Where both are non-empty,
  they must be equal.

### Soft edge (documented, not special-cased)

The facet check is slightly softer than periphery: `deployments/<network>.json`
records the *last deployed* facet address while `diamond.json` records what is
*currently cut into the diamond*. These can legitimately diverge mid-upgrade (facet
redeployed but not yet cut). Committed logs should be consistent, so it remains a
valid commit-time gate; this is noted so a future reader understands why a
transient local divergence is possible.

## Scope: only the networks being touched

Running checks A + B across **all** networks reveals ~26 pre-existing mismatches on
`main` (≈16 facet log-vs-diamond divergences from normal upgrade windows, plus
periphery mismatches mostly on deprecated testnets). A gate that blocks on any of
those would block essentially every deployment-file commit until unrelated debt is
cleaned up. So the **commit gate only checks the networks whose staged files this
commit actually changes**:

- A staged `deployments/<network>.json` or `deployments/<network>.diamond.json` →
  that `<network>` is in scope.
- A staged `config/whitelist.json` → only the networks whose `PERIPHERY` entry
  differs between the staged content and `HEAD` are in scope (compared by parsing
  both versions, not by diff-line heuristics).

This still catches the PR #1890 bug class (you stage the network you're editing, so
its mismatch is checked) and orphan addresses (an address belonging to no network is
caught when that network's whitelist section is in scope), while ignoring unrelated
pre-existing mismatches in networks you did not touch. The manual/CI invocation
(`bun check:addresses`, no flag) still scans **all** networks for full audits.

## Component

A single offline TypeScript script (no RPC), per repo convention (TS under
`script/**`, no Python):

- **Path:** `script/tasks/checkDeploymentAddressConsistency.ts`
- **Pure core:** `findMismatches(sources)` runs checks A + B over the provided
  per-network sources; `affectedNetworks(stagedPaths, changedWhitelistNetworks)`
  derives the in-scope network set from staged paths. Both are unit-tested.
- **Loader:** `loadSources(repoRoot, filter?)` reads the working-tree JSON files,
  optionally restricted to a network filter.
- **CLI:** default (no flag) scans all networks; `--staged` derives the affected
  networks via git (staged file list + staged-vs-HEAD whitelist comparison) and
  checks only those — exiting `0` immediately when nothing relevant is staged.
- **Exit code:** `1` on any in-scope mismatch, `0` otherwise.
- **Address normalization:** lowercase both sides before comparing. Safe for
  EVM hex and for Tron base58 (equality is preserved when both sides are lowercased
  identically).
- **Both checks block:** periphery and facet mismatches both cause a non-zero exit.
  The facet soft-edge friction is bounded by the staged-network scoping above — you
  are only confronted with a facet divergence on a network you are actively editing.

## Enforcement

Wired into `.husky/pre-commit` only:

- The hook already computes `STAGED_FILES`. If any staged path is
  `config/whitelist.json` or under `deployments/`, run the validator in `--staged`
  mode (which scopes itself to the touched networks).
- Follow the hook's existing `print_status` conventions.
- A non-zero exit aborts the commit. Covers humans and agents alike.
- Not bypassed via `--no-verify` policy — same expectation as the rest of the hook.

## Testing & Verification

- **Unit tests** (`bun test`): `findMismatches` over fixture sources — (a) clean set,
  (b) periphery mismatch, (c) facet mismatch, (d) empty/absent ignored; plus
  `affectedNetworks` — deployment paths map to networks, changed-whitelist networks
  included, non-deployment/`_deployments_log_file.json`/`.staging` paths excluded.
- **Live full run:** `bun check:addresses` (no flag) scans all networks — used to
  surface the pre-existing mismatches below; not run by the commit gate.
- **Scoped run:** with only one network's files staged, `--staged` checks just that
  network; inject a one-char mismatch in a staged file → exit 1; revert → exit 0.
- Outputs shown before the work is called done.

## Pre-existing mismatches (surfaced, not fixed here)

A full scan of `main` reports ~26 mismatches: ~16 facet log-vs-diamond divergences
(arbitrum/NEARIntentsFacet, bsc/MayanFacet, optimism/AmarokFacet, zksync/AcrossFacetV4,
metis, boba, taiko, stable, worldchain, …) and ~10 periphery, mostly on deprecated
testnets (goerli, lineatest, okx, nova, mumbai). The only active-mainnet periphery
ones are **mantle/Permit2Proxy** and **worldchain/ReceiverAcrossV3**. These are
out of scope for this feature (and whitelist edits must go via PRs targeting `main`
per rule 502); they are flagged for separate human triage.

## Out-of-scope follow-ups (noted, not built)

- Mirroring the same check in CI as an authoritative backstop (would need a strategy
  for the pre-existing mismatches, e.g. an allowlist or a "no new mismatches" diff).
- A `--staged` variant that fails only on mismatches this commit *introduces*
  (staged-vs-HEAD), rather than any mismatch on a touched network.
- Triage + fix of the pre-existing mismatches above.
- Extending to flag "present in diamond/whitelist but absent from the flat log".
