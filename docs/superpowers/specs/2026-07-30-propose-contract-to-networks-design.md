# Propose Contract To Networks (cut-only / re-propose)

**Date:** 2026-07-30  
**Status:** Approved — implementing (EXSC-725)  
**Context:** Production rollouts sometimes deploy bytecode first and defer Safe proposals (e.g. MayanFacet v2.0.0 / EXSC-364), or must delete and recreate failed proposals. Today only `deployContractToNetworks.sh` (deploy + propose) and `syncWhitelistToNetworks.sh` (whitelist only) exist; cut-only required a one-off script.

## Goal

A first-class, non-interactive path to create (or safely skip) Safe registration proposals for a contract whose address is already recorded in `deployments/<network>.json`, without redeploying bytecode — then shepherd those proposals through the existing multisig-rollout signing/Slack lifecycle when desired.

## Decisions (locked)

| Topic | Choice |
|---|---|
| Surface | Facets + periphery registration + diamond-called periphery allowlist |
| Target selection | Explicit networks **and** `--all-where-deployed` |
| Lifecycle | Bash primitive + `multisig-rollout --propose-only` mode |
| Architecture | Thin wrapper over existing update helpers (not a TS rewrite, not a flag on deploy) |
| Duplicates | Mongo partial unique index on pending `intentHash` (existing) + script preflight skip |

## Non-goals

- Deploying or verifying bytecode (use `deployContractToNetworks.sh` / `deploy-contract`)
- Tron / TronShasta (stay on `deploy-contract-tron` / Tron propose path)
- Deleting or mutating existing Safe proposals (existing Safe tooling)
- Changing how `diamondUpdateFacet` / `diamondUpdatePeriphery` encode cuts
- Automatic PR creation for propose-only when deployment logs are unchanged

## Architecture

```
multisig-rollout --propose-only CONTRACT [networks…]
        │
        ▼
proposeContractToNetworks.sh          ◄── also callable standalone
        │
        ├─ facet     → diamondUpdateFacet (Update<Contract>.s.sol)
        ├─ periphery → diamondUpdatePeriphery
        └─ diamond-called periphery → above + syncWhitelistToNetworks.sh
                │
                ▼
        propose-to-safe.ts → Mongo (intentHash unique among pending)
                │
                ▼
        existing rollout tail: list → confirm-safe-tx → verify → Slack
```

## CLI — `script/tasks/proposeContractToNetworks.sh`

```text
Usage: ./script/tasks/proposeContractToNetworks.sh CONTRACT NETWORK [NETWORK...] [OPTIONS]
       ./script/tasks/proposeContractToNetworks.sh CONTRACT --all-where-deployed [OPTIONS]

Propose Safe registration for CONTRACT using the address already in
deployments/<NETWORK>.json. Does not deploy bytecode.

Arguments:
  CONTRACT               contract name (e.g. MayanFacet, FeeCollector)
  NETWORK                one or more network names from config/networks.json

Options:
  --all-where-deployed   instead of an explicit list: every network where
                         deployments/<net>.json (or .staging.json) has CONTRACT
  --production           production (also requires PRODUCTION=true in .env)
  -h, --help             show this help

Examples:
  ./script/tasks/proposeContractToNetworks.sh MayanFacet mainnet arbitrum base --production
  ./script/tasks/proposeContractToNetworks.sh MayanFacet --all-where-deployed --production
  ./script/tasks/proposeContractToNetworks.sh GasZipPeriphery arbitrum  # staging
```

### Environment gates

Same double opt-in as `deployContractToNetworks.sh` / `syncWhitelistToNetworks.sh`:

- `--production` requires `PRODUCTION=true` in `.env`; without the flag, `PRODUCTION=true` is an error.
- Abort if `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true` in production propose path (would bypass Safe) — match deploy/rollout hard rail.
- Must run from repo root with `.env` present.

### Contract kind resolution

1. Name ends with `Facet` (or matches existing facet detection used by `deployAndAddContractToDiamond`) → facet path: `Update$CONTRACT` via `diamondUpdateFacet`.
2. Else → periphery path: `diamondUpdatePeriphery` for that contract only.
3. Additionally, if `jq -e --arg N "$CONTRACT" '.whitelistPeripheryFunctions | has($N)' config/global.json` → after successful registration proposals, run `syncWhitelistToNetworks.sh` on the succeeded networks (same env flag).

### Network resolution

- **Explicit:** de-dupe the argument list; validate each against `networks.json`.
- **`--all-where-deployed`:** scan `deployments/*.json` (or `*.staging.json` for staging) for a non-null `.$CONTRACT` address; exclude excluded/deprecated networks using the same helpers as other multi-network scripts. Incompatible with also passing NETWORK args (error).

### Execution model

Mirror `deployContractToNetworks.sh`:

1. Resolve version via `getCurrentContractVersion`.
2. Group networks with `groupNetworksByExecutionGroup` (london / cancun / zkevm).
3. `backupFoundryToml` + per-group `updateFoundryTomlForGroup` + build, then wave.
4. Throttle with `MAX_CONCURRENT_JOBS` (validate positive integer).
5. Each worker writes exactly one of `OK` / `SKIP` / `FAIL` into `$RESULT_DIR/$NETWORK` **before** any parent EXIT trap removes the dir. Parent derives summary **after** `wait`, then cleans up.
6. Exit `1` if any network is `FAIL`; `SKIP` does not fail the run.

Prefer sequential (`MAX_CONCURRENT_JOBS=1`) documentation note for worktrees / flaky bun, but honor the env value like deploy does.

### Per-network worker logic

For each `(CONTRACT, NETWORK, ENVIRONMENT)`:

1. **Log address:** resolve from deployment logs; missing → `FAIL`.
2. **On-chain code:** `doesAddressContainBytecode`; empty → `FAIL` (must deploy first).
3. **Already registered:** if the live diamond already maps this contract to that address (facet loupe / periphery registry — reuse existing helpers used by update scripts or diamond log comparison), → `SKIP` with reason `already-registered`.
4. **Propose:** call `diamondUpdateFacet` or `diamondUpdatePeriphery` (timelock-wrapped Safe propose in production).
5. **Duplicate pending:** if `storeTransactionInMongoDB` returns `null` (E11000 / identical `intentHash` pending), treat as `SKIP` with reason `duplicate-pending` — not `FAIL`. Prefer an explicit preflight query by computed intent when cheap; Mongo index remains authoritative.
6. Otherwise success → `OK`.

Whitelist sync (diamond-called periphery only) runs once after the registration wave, on the union of `OK` networks (not on `SKIP`/`FAIL`), using `syncWhitelistToNetworks.sh`. Whitelist’s own duplicate behavior follows existing whitelist tooling.

## Duplicate prevention

**Database (existing):** `unique_pending_intent_hash` — partial unique index on `intentHash` where `status: pending`. Intent hash covers network, chainId, safe, to, value, data, operation (not nonce). Identical re-propose cannot insert a second pending row.

**Script:** Map that outcome to `SKIP`, and optionally preflight so logs say `SKIP duplicate-pending` without a stack-looking warning. Conflicting pending proposals with *different* calldata for the same registration intent are outside intentHash equality — those remain separate Safe nonces; operators delete the wrong one manually (non-goal).

## Skill — `multisig-rollout` propose-only mode

### Invocation

```text
/multisig-rollout --propose-only <Contract> [network…]
/multisig-rollout --propose-only <Contract> --all-where-deployed
```

Update skill `description` / `usage` so phrases like “create the diamond cut proposals”, “propose cuts for already-deployed X”, “re-propose after deleting Safe txs” route here instead of full deploy.

### Phases

| Phase | Behavior |
|---|---|
| 0 Preflight | Same as rollout today (env, gh, Slack MCP warn); do not require clean tree for deploy PR |
| 1 Resolve | Explicit networks or `--all-where-deployed`; report address + whether diamond already matches |
| 2 Confirm | Present plan; wait for go-ahead; state semi-automated Ledger pause |
| 3 Execute | `proposeContractToNetworks.sh … [--production]`; report OK/SKIP/FAIL |
| 3b Whitelist | Handled inside the script when applicable |
| 4 Capture | `list-pending-proposals.ts` for succeeded networks |
| 5 PR | Skip unless the run unexpectedly dirty’d deployment/whitelist files; if whitelist synced, stage those diffs like deploy mode |
| 6–8 | Unchanged: Ledger handoff → verify `signatureCount >= 2` → Slack |

Do **not** call `deploy-contract` in this mode.

## Testing

- Bash: `bash -n script/tasks/proposeContractToNetworks.sh`
- Unit-test any new pure TS helpers (e.g. intent preflight wrapper) with colocated `*.test.ts` at 100% if introduced; prefer reusing `computeProposalIntentHash` / existing Mongo helpers without duplication.
- Manual dry-run documentation: staging propose on one network, or production with a contract already pending → expect `SKIP`.

## Docs / discoverability

- Short section in `docs/Deploy.md` (or adjacent) pointing at propose-only vs deploy.
- Skill + `.agents/commands/multisig-rollout.md` updated in sync (edit `.agents/` source only).

## Implementation sketch (for writing-plans)

1. Add `proposeContractToNetworks.sh` (clone structure from `deployContractToNetworks.sh`, strip deploy, wire update helpers + SKIP outcomes).
2. Extend `multisig-rollout` skill/command for `--propose-only`.
3. Docs touch + `bash -n` / lint as required by finish checklist.
4. No change to Solidity contracts.

## Open points resolved in this spec

- Duplicate policy: skip identical pending; Mongo is the hard gate.
- Drain (`DRAIN_PARKED_TASKS`): not forced by this script; inherits process env / `.env` like today’s propose path (callers who want a clean Mayan-style set should set `DRAIN_PARKED_TASKS=false`).
