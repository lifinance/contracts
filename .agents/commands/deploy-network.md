---
name: deploy-network
description: Brings a brand-new network fully on-chain by driving `deployAllContracts.sh` (scriptMaster use case 3) end to end — CREATE3 factory, Safe, diamond, core + non-core facets, periphery, whitelist sync, wallet funding, health check — one stage at a time so it survives an agent's per-command time limit and needs no interactive terminal. Use after `add-network` has landed the config (networks.json, foundry.toml, target state) and the deployer is funded, when the user wants to "deploy the new network", "bring up <network> on-chain", "run the full deployment for <network>", or "deploy all contracts to <network>". This is the NEW-NETWORK bootstrap path and it runs production in direct-to-diamond mode (`SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true`) because the Safe/timelock does not own the diamond yet. It stops after stage 11 (health check) and never performs stage 12 (ownership transfer) — that stays a deliberate step. NOT for deploying a single contract to existing networks (use `deploy-contract`), NOT for upgrading facets on live Safe-owned networks (use `multisig-rollout`), and NOT for Tron (`tron`/`tronshasta` — Foundry has no Tron support). Requires Foundry, gh, and `MONGODB_URI` in `.env`.
usage: /deploy-network <network> --production [--from-stage N] [--to-stage M]
---

# Deploy Network (LI.FI Contracts)

Drives a full new-network bring-up via the `deployAllContracts` function
(`script/deploy/deployAllContracts.sh`, scriptMaster use case 3), **one stage per fresh shell**.
Every stage is idempotent (CREATE3 → deterministic addresses + `diamondCut`), so a stage that is
interrupted or re-run resumes instead of duplicating work. This lets an agent complete a deploy
that runs far longer than a single command's time budget, with no TTY, by invoking the script
once per stage with the stage range and non-interactive mode preset in the environment.

## When to use this vs other deploy skills

| Situation | Skill |
|---|---|
| Network *config* (networks.json, foundry.toml, target state) | **`add-network`** (run FIRST) |
| Bring a **new** network fully on-chain | **this skill** |
| Deploy/redeploy a **single** contract to existing network(s) | **`deploy-contract`** |
| Upgrade facets/periphery on **existing, Safe-owned** networks | **`multisig-rollout`** |
| Ownership transfer / post-rollout completion | deliberate (`finish-rollout` / stage 12) |

## Hard rails

- **New-network bootstrap only.** Sets `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true` (bypasses the
  Safe) — legitimate ONLY before ownership has moved to the Safe/timelock. If the network is
  already Safe-owned, stop — use `multisig-rollout`.
- **Never runs stage 12 (ownership transfer).** Bounded to stage 11. Ownership transfer is a
  deliberate, reviewed step after the health check is clean.
- **Never edits `.env` silently.** Production flags + any path/verify fixes are shared, symlinked
  state — set them with the user's explicit go, announce it, restore afterward.
- **Tron is out of scope** (no Foundry/CREATE3 support).

## Execution mechanics (read before running anything)

- **Run every command under `bash -c`.** The agent shell is zsh; the deploy scripts use bash-isms
  (`read -a`, associative arrays). Under zsh you get `read: bad option: -a` and silent mis-parses.
- **PATH**: prepend `export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"`.
- **`dangerouslyDisableSandbox: true`** for anything doing network I/O (deploy, verify, cast, mongo).
- **Env overrides that SURVIVE the script's `.env` re-source** (not set in `.env`): `START_STAGE`,
  `END_STAGE`, `NON_INTERACTIVE`. Set these inline. Anything already in `.env` (`PRODUCTION`,
  `VERIFY_CONTRACTS`, `GLOBAL_FILE_PATH`, `DO_NOT_VERIFY_IN_THESE_NETWORKS`) is re-sourced by the
  script and CANNOT be overridden by an export — edit the `.env` file for those.
- **Output is huge** (bytecode dumps on single lines) — pipe to a log file and `grep` for markers
  (`STAGE N completed`, `successfully verified`, `Failed`, `Error:`), do NOT tail raw.
- **10-min SIGTERM**: the agent's Bash tool hard-kills any command (incl. backgrounded) at ~10min.
  Run one stage per shell; a stage that neither completes nor progresses across a re-run cap (~5)
  → stop and surface, don't loop.

## Phase 0 — Preflight (do IN THIS ORDER; report, don't silently fix)

1. **`add-network` landed**: network present in `config/networks.json`, `foundry.toml`
   (`[rpc_endpoints]` + `[etherscan]`), and `script/deploy/_targetState.json`.
2. **Submodules**: `git submodule update --init --recursive` (fresh worktrees have none → forge
   import resolution fails).
3. **node_modules**: symlink the main checkout's `node_modules` (avoids `bun.lock` churn) or
   `bun install` — needed for TS tooling + lint-staged.
4. **typechain**: `bun typechain:incremental` — TS deploy helpers (`deploy-safe.ts`, etc.) crash
   `ERR_MODULE_NOT_FOUND … /typechain` without it. `forge build` does NOT generate it.
5. **Fresh build**: `forge clean && forge build` (CREATE3 salt derives from `out/`).
6. **`GLOBAL_FILE_PATH` sanity**: `source .env` and assert `GLOBAL_FILE_PATH` resolves to an
   existing file from repo root (framework default `config/global.json`). A stale relative value
   like `./../config/global.json` silently breaks stage 2. Empty `NETWORKS_JSON_FILE_PATH` is fine
   (falls back to default).
7. **Verifier endpoint probe**: for blockscout networks the verify API is often a SEPARATE
   subdomain (e.g. `blockscout-api.<chain>` not the explorer UI `blockscout.<chain>`). Probe the
   `explorerApiUrl` returns JSON, not HTML — a wrong URL makes verification 404, which the deploy
   misreads as a gateway timeout and RETRIES WITH BACKOFF, throttling everything.
8. **RPC**: prefer a **premium RPC** (Alchemy/Quicknode). Public RPCs can be ~1.4s/call → 30-60s
   of forking PER contract; a premium RPC is ~2x+ faster. Add via `bun add-network-rpc --network
   <net> --rpc-url <url>` then `bun fetch-rpcs` (RPC Mongo is separate/unprotected — no
   lifi-connect needed). Stage 1 auto-adds the `networks.json` public rpcUrl if none is set.
9. **corePeriphery ↔ target-state reconciliation** (prevents silent gaps): diff
   `config/global.json` `corePeriphery` against the parsed target-state periphery. Flag
   (a) corePeriphery items MISSING from the target state → they won't deploy (add to the sheet),
   and (b) deprecated items still in corePeriphery → they'll fail the health check forever (remove
   from corePeriphery). Account for legitimate per-chain skips: GasZip* (no gaszip config),
   Permit2Proxy (no Permit2 on chain).
10. **Version currency**: check the target-state parse warnings for "differs from current" — a
    stale sheet deploys old versions. Critically, ERC20Proxy must be **>= 1.2.0** or the Executor
    is NOT pre-authorized (forces a manual `setAuthorizedCaller`). Update the sheet + re-parse if stale.
11. **Deployer funded** (stage 1 aborts on 0). Pauser/Dev are funded automatically at stage 9 via
    `NON_INTERACTIVE` defaults — do NOT pre-require them.
12. **Production flags**: edit `.env` → `PRODUCTION=true` and `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true`.

## The stages

| # | Stage | Notes |
|---|---|---|
| 1 | Setup + CREATE3Factory (+ Safe on production) | RPC self-heals here |
| 2 | Deploy core facets | GasZipFacet skipped if no gaszip config |
| 3 | Deploy diamond + cut in core facets | |
| 4 | Approve refund wallet | |
| 5 | Deploy non-core facets + cut | empty for a core-only setup |
| 6 | Deploy periphery | Permit2Proxy/GasZipPeriphery skipped if unconfigured |
| 7 | Register periphery in diamond | |
| 8 | Whitelist sync | writes `config/whitelist.json` (deploy-generated, commit it) |
| 9 | Fund Pauser + Dev | `NON_INTERACTIVE` uses computed defaults |
| 10 | Verify Executor authorization | "already authorized" when ERC20Proxy >= 1.2.0 |
| 11 | Health check | bounded stop here |
| 12 | Ownership transfer | **skipped by this skill** |

## Phase 1 — Drive the stages

Deploy with **verification OFF** for speed (verify in Phase 2 instead). One stage per shell:

```bash
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
cd <network-worktree>
START_STAGE=<N> END_STAGE=<N> NON_INTERACTIVE=true VERIFY_CONTRACTS=false \
  bash -c 'source script/deploy/deployAllContracts.sh; deployAllContracts <network> production' \
  2>&1 | sed 's/\x1b\[[0-9;]*m//g' > /tmp/stage<N>.log
grep -c "STAGE <N> completed" /tmp/stage<N>.log   # 1 = advance; 0 = inspect/re-run
```

(`deployAllContracts` preserves a caller-provided `VERIFY_CONTRACTS` across its `source .env`, so
the inline `VERIFY_CONTRACTS=false` above genuinely disables verification even when `.env` sets it
to `true` — no need to edit `.env`. Deploying verification-off avoids inline `--watch` blocking and
Blockscout indexing-lag failures; verify in the Phase-2 sweep instead.)

- **Marker present** → advance to N+1. **Absent** → re-run the same stage (idempotent; heavy
  stage 5 may need a few re-runs). Cap ~5; then stop + surface with the log.
- **Transient RPC/DNS**: a stage may fail once with `could not instantiate forked environment …
  dns error`; a plain re-run usually succeeds. Retry before deep diagnosis.
- Runs auto-stop after stage 11 (`END_STAGE < 12`), leaving the deployer as diamond owner — the
  correct resumable pre-ownership-transfer state.

## Phase 2 — Verify all contracts (parallel, rate-limit-aware)

Run ONCE after all deploys (Blockscout has had time to index → avoids "address is not a smart
contract" races). The master log is in **MongoDB** — `bun mongo-logs:sync` refreshes the local
cache (`_deployments_log_file.json`) so logged `constructorArgs`/`solc`/`evm` are available.

Use `verifyNetworkContractsParallel <network> <environment>` (ships with this skill): verifies all
unverified contracts for the network concurrently (capped at `MAX_CONCURRENT_JOBS`), with
**Blockscout rate-limit backoff** (429/gateway → exponential retry), then pushes `verified:true`
back to MongoDB. Confirm with `bun mongo-logs:query`. Re-run to mop up any left by rate limits.

## Phase 3 — Land results

- Commit `deployments/<net>.json`, `<net>.diamond.json`, and the stage-8 `config/whitelist.json`
  additions → turns `check-new-network-health` green.
- Restore `.env` (`PRODUCTION=false`, `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=` empty; keep
  `GLOBAL_FILE_PATH` fixed).
- Health check will still note, by design: GasZip/Permit2 (unconfigured/N-A) and diamond ownership
  (stage 12 deferred). Those are expected, not failures.

## Hand-offs

- **Ownership transfer** (stage 12) → deliberate step / `finish-rollout` once the health check
  shows only ownership errors.
- **Bridge integrations** → their own follow-up deploys.
