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

## Component

A single offline TypeScript script (no RPC), per repo convention (TS under
`script/**`, no Python):

- **Path:** `script/tasks/checkDeploymentAddressConsistency.ts`
- **Behaviour:** scans every network that has a `deployments/<network>.diamond.json`
  (pure JSON parsing — fast), runs checks A and B, prints a report grouped by
  network and check type showing each conflicting address and the file it came from.
- **Exit code:** `1` on any mismatch, `0` otherwise.
- **Address normalization:** lowercase both sides before comparing. Safe for
  EVM hex and for Tron base58 (equality is preserved when both sides are lowercased
  identically).

## Enforcement

Wired into `.husky/pre-commit` only:

- The hook already computes `STAGED_FILES`. If any staged path is
  `config/whitelist.json` or under `deployments/`, run the validator over **all**
  networks (the full scan is cheap and also catches cross-network copy-paste).
- Follow the hook's existing `print_status` / parallel-task conventions.
- A non-zero exit aborts the commit. Covers humans and agents alike.
- Not bypassed via `--no-verify` policy — same expectation as the rest of the hook.

## Testing & Verification

- **Unit test** (`bun test:ts`): feed fixture JSON with (a) a clean set → exit 0,
  (b) a periphery mismatch → exit 1, (c) a facet mismatch → exit 1, (d) empty-string
  and absent entries → ignored (exit 0).
- **Live repo run:** execute against the current repository — must pass now that the
  `optimismsepolia` OutputValidator entry is fixed.
- **Negative live run:** temporarily reintroduce the `0x293BEf…` orphan, confirm the
  script exits 1 and names `optimismsepolia` / OutputValidator, then revert.
- Both outputs shown before the work is called done.

## Out-of-scope follow-ups (noted, not built)

- Mirroring the same check in CI as an authoritative backstop.
- Extending to flag "present in diamond/whitelist but absent from the flat log"
  as a warning (currently skipped under "agree where present").
