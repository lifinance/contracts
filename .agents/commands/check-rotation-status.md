---
name: check-rotation-status
description: Verify a wallet rotation / SC-dev offboarding is complete across all active networks — Safe-owner membership (old removed / new added), Timelock CANCELLER_ROLE (old removed / new granted), whitelist permission, staging-diamond `owner()`, and wallet funding (the CI funding check). Generalizes the hardcoded `script/tasks/temp/checkOffboardingStatusPerNetwork.ts` (whose addresses are baked-in module constants) into a reusable, flag-driven check that takes old/new addresses as citty flags — writing that generalized checker is this skill's real work. Read-only, so it is the natural final gate for every rotate-* skill and the `offboard-sc-dev` orchestrator. Use when the user says "check the offboarding status", "verify the rotation is complete", "is the deployer/dev rotation done across all chains", "run the rotation status check", or similar. NOT for performing any rotation step — those are `rotate-dev-wallet` / `rotate-deployer-wallet` / `rotate-pauser-wallet`. Requires `bun` and RPC access (premium RPC via `ETH_NODE_URI_<NETWORK>` env vars recommended).
usage: /check-rotation-status --old-address 0xOLD --new-address 0xNEW [--role deployer|dev|pauser] [--removed-signer 0x] [--network <csv>] [--production]
---

# Check Rotation Status

## Purpose

Confirm, across every active network, that a wallet rotation actually landed
on-chain — not just that the PRs merged. It reads the same set of facts a
completed rotation must satisfy and prints a per-network pass/fail matrix:

- **Safe multisig membership** — old signer removed, new signer added.
- **Timelock `CANCELLER_ROLE`** — old deployer's role revoked, new deployer's
  granted (deployer rotations).
- **Whitelist permission** (`AccessManagerFacet.addressCanExecuteMethod`) — old
  deployer's whitelist authority removed; whitelisting moved to the multisig.
- **Staging diamond `owner()`** — matches the current dev wallet from config.
- **Wallet funding** — the rotated-in wallet has gas on each chain (the CI
  funding check), so it can actually operate.

Because it changes nothing, it is the completeness gate at the end of every
`rotate-*` flow and of `offboard-sc-dev`.

## The real work: generalize the hardcoded temp checker

`script/tasks/temp/checkOffboardingStatusPerNetwork.ts` already implements the
per-network read logic (Safe owners via `getOwners`, Timelock `CANCELLER_ROLE`
via `hasRole`, whitelist via `addressCanExecuteMethod`, staging `owner()`), the
parallel fan-out over active networks, the `tron`/`tronshasta` exclusion, and
the colored pass/fail table. **But its addresses are hardcoded module
constants** (`OLD_DEPLOYER`, `NEW_DEPLOYER`, `MICHAL_SAFE_SIGNER`,
`OLD_SC_DEV_WALLET`, `NEW_SC_DEV_WALLET`) tied to one offboarding cycle — so it
cannot be reused for the next rotation without editing source.

This skill owns turning that one-off into a **flag-driven, reusable** check.
Concretely:

1. Copy the read logic out of `temp/` into a permanent home
   (e.g. `script/tasks/checkRotationStatusPerNetwork.ts`) — keep the `temp/`
   file as the reference implementation; do not delete it as part of this skill.
2. Replace the hardcoded constants with **citty flags** (camelCase, matching
   the repo's other citty scripts):

   - `--oldAddress` (required) — the rotated-OUT EVM address.
   - `--newAddress` (required) — the rotated-IN EVM address.
   - `--role` — `deployer` | `dev` | `pauser`, selects which checks apply
     (a dev rotation has no CANCELLER/whitelist columns; a pauser rotation is
     the funding + config check).
   - `--removedSigner` (optional) — an additional departing Safe signer to
     assert removed (the `MICHAL_SAFE_SIGNER` case, for offboarding).
   - `--network` (optional) — restrict to one network; default all active.
   - `--json` (optional) — machine-readable output for the orchestrator.

   Wrap each address flag in viem's `getAddress()` at parse time (as the temp
   script does with its constants) so a mistyped literal fails fast at startup
   rather than silently flipping a check to a false pass.
3. Preserve the existing exclusions (`tron`, `tronshasta` are non-EVM → shown
   as `-`) and the premium-RPC-first resolution (`getRPCEnvVarName` →
   `ETH_NODE_URI_<NETWORK>` fallback to `networks.json`).

Until that generalized script exists in the branch, this skill's first action
is to create it; do not shell out to the `temp/` file with edited constants.

## When to use / when NOT

Use when the user says any of:

- "check the offboarding / rotation status"
- "verify the rotation is complete" / "is the deployer rotation done everywhere"
- "run the rotation status check across all chains"

Called as the final gate by `rotate-dev-wallet`, `rotate-deployer-wallet`,
`rotate-pauser-wallet`, and `offboard-sc-dev`.

Do NOT use to *perform* any rotation step (Safe owner swap, role move, funding).
Those belong to the `rotate-*` skills and `multisig-rollout`. This skill only
reads and reports.

## Inputs

Required:

- **--old-address** — `0x…` rotated-OUT EVM address.
- **--new-address** — `0x…` rotated-IN EVM address.

Optional:

- **--role** — `deployer` (default; full column set) | `dev` (staging owner +
  funding) | `pauser` (funding + config). Selects applicable checks.
- **--removed-signer** — extra departing Safe signer to assert removed.
- **--network** — restrict to the given network(s) (csv); default all active.
- **--production** — target production (default staging), mirroring the
  `.env PRODUCTION=true` double-opt-in rail.

## Guardrails

- **Read-only.** This skill and its script make only `view`/`call` RPC reads.
  It never signs, broadcasts, or writes config. It is safe to run any number of
  times and is the intended dry-run gate for the rotations.
- **Custody guard.** The addresses under test must be SC-owned roles
  (**deployer, dev, pauser**). Never run a "rotation complete" assertion against
  refund / feeCollector / withdraw (CTO-owned) addresses — those are not rotated.
- **Fail fast on bad input.** `getAddress()`-wrap both address flags so a typo
  aborts at startup instead of reporting a green (a wrong-but-well-formed
  address would read as "old already removed / not present" and falsely pass).
- **No silent RPC downgrade.** Networks that error (RPC auth/403/deprecated) are
  reported as `❓ with errors`, never counted as passing. Prefer premium RPC via
  `ETH_NODE_URI_<NETWORK>`.
- **Exit codes** (so an orchestrator can branch): `0` = all applicable checks
  pass on all reachable networks; `1` = at least one check failed on a reachable
  network (rotation incomplete — report which); `2` = recoverable misconfig
  (e.g. required RPC env missing for networks that erred — name the var). Tron
  exclusions and genuinely-absent staging diamonds are not failures.
- Foundry/bun may need `export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"`.

## Workflow

### 1. Ensure the generalized checker exists (this skill's build step)

If `script/tasks/checkRotationStatusPerNetwork.ts` does not yet exist on the
branch, create it per "The real work" above — lift the read logic from
`script/tasks/temp/checkOffboardingStatusPerNetwork.ts`, swap the hardcoded
constants for citty flags, keep the exclusions and premium-RPC resolution.
Leave the `temp/` script in place as the reference.

### 2. Run the check

```bash
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"

bunx tsx script/tasks/checkRotationStatusPerNetwork.ts \
  --oldAddress 0xOLD --newAddress 0xNEW --role deployer
```

Add `--removedSigner 0x…` for an offboarding that also drops a departing Safe
signer, `--network <name>` to scope to one chain, or `--json` for the
orchestrator. The script fans out over active networks in parallel and prints
the per-network matrix plus a summary (`✅ completed / ❌ incomplete / ❓ errors`).

### 3. Interpret the matrix

- **All applicable columns ✅ on every reachable network** → rotation complete
  for that role (exit `0`).
- **Any ❌** → that check has not landed on that network; name the network +
  column and hand back to the owning rotation step (do not "fix" it here).
- **`❓` / errors** → RPC connectivity, not a rotation failure. Re-run with a
  premium `ETH_NODE_URI_<NETWORK>` set; if still unreachable, report the network
  as unverified rather than pass or fail.
- **`-` (tron/tronshasta)** → excluded EVM-check-wise; Tron completeness is
  verified separately by `move-tron-delegation` (delegation) and the Tron
  ownership move — call that out, don't imply Tron is covered here.

## Verification

State the outcome precisely:

- Per-network pass/fail for each applicable column, and the summary counts.
- Networks that errored (and the env var to set to re-verify them).
- An explicit "rotation complete" claim ONLY when every applicable check is ✅
  on every reachable network AND the Tron side has been confirmed by its own
  skill. Otherwise list exactly what remains and which skill owns it.

## Reuse map

- `script/tasks/temp/checkOffboardingStatusPerNetwork.ts` — reference
  implementation this skill generalizes (hardcoded → flag-driven).
- `config/networks.json` + `getRPCEnvVarName` / `getViemChainForNetworkName` /
  `getDeployments` — network list, RPC resolution, chain + deployment lookups
  reused by the generalized script.
- `move-tron-delegation` — verifies the Tron delegation half (this skill
  excludes Tron from EVM checks).
- `rotate-dev-wallet` / `rotate-deployer-wallet` / `rotate-pauser-wallet` /
  `offboard-sc-dev` — callers that use this skill as their completeness gate.
