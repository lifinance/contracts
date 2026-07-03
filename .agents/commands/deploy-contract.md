---
name: deploy-contract
description: Deploys a facet/periphery contract (the version currently in the repo) to one or more networks and registers it in each network's LiFiDiamond — deploy, explorer-verify, diamondCut (facets) or diamondUpdatePeriphery (periphery), plus the diamond allowlist sync for diamond-called periphery. Use whenever the user wants to "deploy <Contract> to <networks>", "redeploy <Facet> on staging", "push <Periphery> to base/optimism", or otherwise get a contract on-chain and into the diamond WITHOUT the Safe-proposal lifecycle. This is the staging/test deploy path and is the deploy primitive that `multisig-rollout` calls. For a PRODUCTION rollout — anything that needs Safe proposals shepherded to signing ("roll out vX.Y.Z to all chains", "upgrade <Facet> in production", "create the diamond cut proposals") — use `multisig-rollout` instead; it calls this skill and then drives the proposal → PR → signing → Slack tail. Requires Foundry, gh, and (production only) VPN for MongoDB.
usage: /deploy-contract <ContractName> <network...> [--production]
---

# Deploy Contract (LI.FI Contracts)

Non-interactive deploy of a single contract to N networks via `script/deploy/deployContractToNetworks.sh` (scriptMaster use case 1, repeated). Per network it deploys (CREATE3), verifies on the explorer, and registers in the LiFiDiamond:

- **facet** → `diamondCut` (a Safe proposal in production, direct cut in staging)
- **periphery** → `diamondUpdatePeriphery`
- **diamond-called periphery** → the above **plus** an allowlist sync (a second proposal in production)

It stops once the contract is deployed, verified, and registered (production: proposal created carrying the deployer's signature). In the standalone staging path it also lands the resulting deployment-log changes via a draft PR (Phase 4). It never drives hardware-wallet signing or posts to Slack — and in production it leaves the PR to `multisig-rollout`.

See also: `rotate-pauser-wallet` calls this skill to redeploy `EmergencyPauseFacet` with the new pauser when rotating the pauser wallet.

## When to use this vs multisig-rollout

| Situation | Skill |
|---|---|
| Staging / testnet / non-governed deploy (terminal) | **this skill** |
| Production rollout needing Safe proposals signed & shepherded | **`multisig-rollout`** (it calls this skill) |

**Hard rail — don't strand production proposals.** A standalone production deploy creates Safe proposals carrying a single signature and then stops; with no PR, no signing hand-off, and no Slack thread, those proposals sit forgotten below threshold. So: if this is a production deploy (`--production`) and you are **not** running it as a step inside `multisig-rollout`, stop and route the user to `/multisig-rollout`. Only proceed with `--production` here when `multisig-rollout` is driving the full lifecycle around you.

**PR ownership.** The staging path opens its own deployment-log PR (Phase 4). The production PR is **not** this skill's job — when `multisig-rollout` drives, skip Phase 4; it opens the single combined PR (logs + nonce table) after capturing proposals.

## Environment

The target environment is a double opt-in enforced by the script: staging unless **both** `--production` is passed *and* `PRODUCTION=true` is in `.env`. Default standalone use is staging. Never edit `.env` to flip this — if `--production` and `.env` disagree, the script aborts; relay that to the user.

## Phase 0 — Preflight

Run from the repo root. Check and report (don't fix silently):

- `.env` exists; `PRODUCTION` matches the intended environment (`true` only for a production run); `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND` not `true` for production (it bypasses the Safe — legitimate only when bootstrapping a new production network before ownership transfers to the Safe; abort otherwise); `MAX_CONCURRENT_JOBS` set.
- Foundry available (`forge --version`); `gh auth status` OK.
- Working tree state noted — the deploy writes `deployments/<net>.json` (and, for diamond-called periphery, `config/whitelist.json`), which the caller commits later.

## Phase 1 — Resolve targets

The target list comes from one of two sources:

- **Explicit** — the user names the networks ("deploy MayanFacet to arbitrum, base, sei"). Use exactly those, in the order given. This is how a contract reaches a **new** network it isn't live on yet. The only requirement is that each named network already hosts a LiFiDiamond (this flow adds the contract to an existing diamond; it does **not** stand up a brand-new network — that's `/add-network` + a full deploy). If a named network has no diamond, flag it and drop it.
- **Discovery** (when the user says "all chains where it's running" or names none) — networks where the contract is already live in the production diamond, plus its deployed version:

```bash
for F in deployments/*.diamond.json; do
  NET=$(basename "$F" .diamond.json)
  V=$(jq -r --arg N "<Contract>" '(.LiFiDiamond.Facets // {}) | to_entries[] | select(.value.Name == $N) | .value.Version' "$F" 2>/dev/null | head -1)
  [ -n "$V" ] && echo "$NET $V"
done
```

For periphery contracts check `.LiFiDiamond.Periphery | has($N)` instead. The glob matches only production logs (`*.diamond.staging.json` and `*.diamond.immutable.json` do not end in `.diamond.json`).

Repo version: `grep -m1 "@custom:version" src/Facets/<Contract>.sol` (or `src/Periphery/...`). Report old → new version per network (a new network shows no current version — expected). Networks already on the repo version are re-deployed only if the user asked — surface them and ask.

**Diamond-called periphery needs a second proposal.** A periphery contract the diamond invokes during swaps (e.g. `GasZipPeriphery`, `FeeCollector`, `LiFiDEXAggregator`) must be **both** registered in the diamond *and* added to the diamond's allowlist — registration alone (`PeripheryRegistry`) does not let the diamond call it. Detect deterministically:

```bash
jq -e --arg N "<Contract>" '.whitelistPeripheryFunctions | has($N)' config/global.json >/dev/null && echo "needs whitelist sync"
```

If it matches, Phase 3b runs an allowlist sync afterwards (a second production proposal). No manual `whitelist.json` editing: the sync derives the address + selectors from `global.json.whitelistPeripheryFunctions` automatically. Facets and non-diamond-called periphery skip Phase 3b.

## Phase 2 — Confirm plan

Present: contract + version (old → new per network), the full network list, environment, and what will be created (per network: one registration; **two** for a diamond-called periphery — registration + allowlist; in production each is a timelock-wrapped Safe proposal). Wait for explicit go-ahead — deployments cost gas and, in production, mint Safe proposals on many chains.

## Phase 3 — Execute

Run in the background (long-running; deploys retry and verify inline), monitor output, report per-network results:

```bash
# staging (default)
./script/deploy/deployContractToNetworks.sh <Contract> <network...>

# production (only inside multisig-rollout — see hard rail)
./script/deploy/deployContractToNetworks.sh <Contract> <network...> --production
```

Ends with a per-network summary and exits `1` if any network failed. Failures don't block survivors: continue with the succeeded networks, report the failed ones, and offer to retry them individually with the same command. In production each proposal is created already carrying one signature (`signatureCount: 1`).

## Phase 3b — Whitelist a diamond-called periphery

Run only when Phase 1 flagged the contract as diamond-called. After the deploy registered it, sync the allowlist on the same networks:

```bash
# staging sends directly; production proposes (and re-syncs staging afterwards — expected)
./script/tasks/syncWhitelistToNetworks.sh <network...> [--production]
```

This re-derives `whitelist.json` from `global.json.whitelistPeripheryFunctions` (picking up the just-deployed address) and applies a `batchSetContractSelectorWhitelist` cut — the second proposal per network in production. Skip entirely for facets and non-diamond-called periphery.

## Phase 3c — Verify deployed contracts

The deploy framework attempts explorer verification inline, but it can fail, and the MongoDB `verified` flag is written separately from on-chain verification. Confirm every freshly deployed contract is verified by invoking the `verify-contracts` skill for each target network:

```text
/verify-contracts <network>
```

It verifies the deployment's addresses on the explorer and writes `verified:true` to MongoDB (both must hold).

## Phase 4 — Commit logs & draft PR (staging path only)

Skip this phase entirely when `multisig-rollout` is driving (production): the
orchestrator opens one combined PR after capturing proposals, because that body
needs the per-network Safe nonce table that doesn't exist until then. In the
standalone staging path the deploy's only leftover is the deployment-log diff,
and landing it shouldn't be a manual afterthought.

1. Collect exactly what the deploy touched — **never `git add -A`**:

   ```bash
   git status --porcelain -- deployments/ 'config/whitelist*.json'
   ```

   The contract type need not be special-cased: a facet writes the diamond log's
   Facets section + address map, periphery writes the Periphery section, a
   diamond-called periphery also rewrites `config/whitelist.json` /
   `config/whitelist.staging.json` (Phase 3b) — staging whatever changed covers
   all of them. If the output is empty (idempotent re-deploy — same CREATE3
   address, version already registered), there's nothing to land; skip.

2. Delegate the branch / commit / template / `/pr-ready` / push / create mechanic
   to `/create-pr`, passing:
   - **files to stage**: exactly the paths from step 1.
   - **body** (the "Why"): contract, version (old → new per network), network
     list, environment (staging), and the registration note for the type —
     `diamondCut` (facet) / `diamondUpdatePeriphery` (periphery) / `+ allowlist
     sync, whitelist.json updated` (diamond-called periphery).

`/create-pr` stages only the named files and has a confirm gate, so a routine
staging deploy isn't force-PR'd — you approve before it pushes. Don't reimplement
branching/commit/PR plumbing here; `/create-pr` owns it.

## Output

Report a per-network result table the caller (or user) can act on:

| Field | Source |
|---|---|
| `contract`, `version` | Phase 1 (repo `@custom:version`) |
| `network`, `chainId` | target list / `config/networks.json` |
| `address` | deploy summary / `deployments/<net>.json` |
| `registration` | `diamondCut` (facet) or `diamondUpdatePeriphery` (periphery); `+ allowlist` if Phase 3b ran |
| `proposalCreated` | production only — one per registration (sig 1); two for diamond-called periphery |
| `verified` | Phase 3c result |

In production, note the files changed on disk (`deployments/<net>.json`, and `config/whitelist.json` / `config/whitelist.staging.json` if Phase 3b ran) so the caller commits them, and that proposals carry a single signature awaiting the signing lifecycle. When run inside `multisig-rollout`, hand this table back so it can capture proposal nonces, draft the PR, and run the signing tail.

## Failure modes

- `--production` / `.env` mismatch → script aborts with a clear message; do not edit `.env`, relay it.
- Deploy succeeded but production proposal missing → the propose step failed; check the network's deploy log and re-run that single network.
- A network has no diamond → drop it from the list (this skill adds to existing diamonds only).
- Explorer verification flaky → re-run `/verify-contracts <network>`; the MongoDB `verified` flag and on-chain verification must both hold.
