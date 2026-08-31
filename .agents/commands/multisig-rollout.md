---
name: multisig-rollout
description: Orchestrates a PRODUCTION multisig rollout end-to-end — deploy (via `deploy-contract`), propose-only for already-deployed bytecode, or whitelist sync across chains — then captures Safe proposals, drafts a PR when needed, hands hardware-wallet signing to the user, verifies signatures in MongoDB, and posts the #dev-sc-multisig-proposals Slack thread. Use for "roll out <Facet> vX.Y.Z", "create the diamond cut proposals", "propose cuts for already-deployed X", "re-propose after deleting Safe txs", "sync the whitelist for PR <N>", or Polymer CCTP domain propagation. Also triggers on a bare "deploy <Contract> to <network>" or "the receiver is missing on <chain>" when the target is a mainnet/production diamond — production deploys ALWAYS enter here, never `deploy-contract` directly, because registration needs Safe proposals shepherded to signing. Staging/test deploy without the proposal lifecycle → `deploy-contract`. Requires lifi-connect (MongoDB), gh, and Slack MCP.
usage: /multisig-rollout <ContractName> | /multisig-rollout --propose-only <ContractName> [networks…] | /multisig-rollout --whitelist-pr <PR number or URL>
---

# Multisig Rollout (LI.FI Contracts)

Drives the production rollout lifecycle in three modes:

- **deploy mode** — get a facet/periphery contract (version currently in the repo) on-chain across production networks and proposed to each Safe. The deploy itself (preflight, target resolution, the deploy, diamond-called-periphery allowlist sync, explorer verification) is delegated to the **`deploy-contract`** skill; this skill owns the proposal lifecycle around it.
- **propose-only mode** — bytecode already in `deployments/<net>.json` (deferred cuts, recreate-after-delete). Runs `proposeContractToNetworks.sh` — no CREATE3. Same signing/Slack tail as deploy.
- **whitelist mode** — given a merged whitelist PR, sync `config/whitelist.json` onto the affected chains' diamonds, proposing the changes to each chain's Safe.

All modes converge on the same tail: capture proposals → (deploy mode only, or propose-only when whitelist files dirty) draft PR → hand off hardware-wallet signing → verify signatures in MongoDB → post the `#dev-sc-multisig-proposals` Slack thread.

**Per-diamond chainId-mapping add-on**: a `PolymerCCTPFacet` or `FraxFacet` rollout that adds a chain also has to propagate its chainId mapping to every already-live chain — extra Safe proposals that ride through the same tail. See Phase 3b.

**Signing model** (Safe threshold is 3): a freshly created proposal already carries one signature. The user running this skill adds a second via `confirm-safe-tx.ts`. The Slack thread then recruits the remaining signer(s) to reach the threshold, the last of whom executes. So the verification gate before posting is "the runner has signed" — `signatureCount >= 2` — deliberately short of the threshold; recruiting the rest is the whole point of the Slack ask.

See also: the wallet-rotation orchestrators `rotate-deployer-wallet` and `offboard-sc-dev` drive this skill to propose Safe owner / CANCELLER-role swaps.

## Hard rails

- **Never run `confirm-safe-tx.ts` yourself.** Signing uses the user's hardware wallet; only the human can do it. Your job ends at giving the exact command.
- **Never post to Slack before the signature verification gate passes.** The Slack message asks the team to spend their time signing — it must be accurate.
- **Production double opt-in**: the entry scripts (`deployContractToNetworks.sh` via `deploy-contract`, `proposeContractToNetworks.sh`, and `syncWhitelistToNetworks.sh`) require `--production` on the CLI *and* `PRODUCTION=true` in `.env`. Do not edit `.env` to satisfy this — if it mismatches, stop and tell the user.
- `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND` must NOT be `true` (it would bypass the Safe). Abort if set.
- Confirm the resolved plan (contract/version/networks or PR/networks) with the user before executing — deployments cost gas and mint Safe proposals on many chains.

## Phase 0 — Preflight

**Proceed optimistically — do not pre-gate on tunnel or signing.** Assume the human has the `lifi-connect` tunnel up (per `docs/Setup-agents.md`). Do not ask "how should we run this given I can't open the tunnel / sign" — just execute. The MongoDB scripts fail fast (`list-pending-proposals.ts` exits `2`) if the tunnel is actually down, and signing is handed off in Phase 6 when it's actually needed. The only up-front gate is confirming the resolved plan (contract/version/networks) in Phase 2, since it costs gas across many chains.

Run from the repo root. Check and report (don't fix silently) the lifecycle prerequisites:

- `.env` exists, `PRODUCTION=true`, `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND` not `true`, `MAX_CONCURRENT_JOBS` set.
- `gh auth status` OK; Slack MCP connected (needed in Phase 8 — warn early if missing, posting falls to the user).
- Working tree clean enough to branch later (deploy mode creates a PR from deployment-log changes).
- lifi-connect tunnel: verified implicitly later — `list-pending-proposals.ts` exits `2` with a clear message when the tunnel is down; relay that to the user when it happens.

In deploy mode, `deploy-contract` re-checks the deploy-side prerequisites (Foundry, deployer balances, the `.env`/`--production` agreement) before touching any network — don't duplicate that here.

## Phase 1 — Resolve targets

**Do not invoke `deploy-contract` yet.** Phase 1 is target-resolution only; the deploy runs in Phase 2 after the user confirms the plan.

### deploy mode

If the user named explicit chains, use those. Otherwise discover every chain where the contract is already live:

```bash
for F in deployments/*.diamond.json; do
  NET=$(basename "$F" .diamond.json)
  V=$(jq -r --arg N "<Contract>" '(.LiFiDiamond.Facets // {}) | to_entries[] | select(.value.Name == $N) | .value.Version' "$F" 2>/dev/null | head -1)
  [ -n "$V" ] && echo "$NET $V"
done
```

Repo version: `grep -m1 "@custom:version" src/Facets/<Contract>.sol` (or `src/Periphery/...`). Report old → new per network. Check if the contract is diamond-called (needs a second allowlist proposal per network):

```bash
jq -e --arg N "<Contract>" '.whitelistPeripheryFunctions | has($N)' config/global.json
```

Also resolve any **required companion periphery** before confirming the plan — a facet with a `facetPeripheryCouplings` entry in `config/global.json` needs its companion deployed *and* registered on every target chain, or destination calls stay disabled there. `deploy-contract` Phase 1 carries the detection recipes; run them here too, since propose-only and whitelist modes never call that skill.

### propose-only mode — resolve targets

Triggered by `--propose-only <Contract>` (or natural language: “create the cuts”, “propose already-deployed”, “re-propose after delete”). **Do not deploy.**

- Explicit networks if the user named them; otherwise `--all-where-deployed` (every network with a non-null address in `deployments/<net>.json`).
- Report per network: log address, whether on-chain code exists, whether the diamond already registers that address.
- Diamond-called periphery (`jq -e --arg N "<Contract>" '.whitelistPeripheryFunctions | has($N)' config/global.json`) → expect a second allowlist proposal per OK network (handled inside the script).

### whitelist mode — resolve targets

If the user didn't supply a whitelist PR (number or URL), ask for it — don't guess from recent merges or the working tree. The PR defines exactly which whitelist change is being rolled out and is the link the Slack post references.

The input PR must be **merged to main** (whitelist changes are main-only by policy; the sync reads the local file). If it's open, stop and point the user at the merge first. Then, on up-to-date main, derive affected networks from the PR's whitelist diff (verified recipe):

```bash
MERGE=$(gh pr view <N> --repo lifinance/contracts --json mergeCommit --jq '.mergeCommit.oid')
PROG='[ (.DEXS[]? | .contracts | to_entries[] | {k: .key, v: .value}), (.PERIPHERY | to_entries[]? | {k: .key, v: .value}) ] | group_by(.k) | map({key: .[0].k, value: (map(.v) | tojson)}) | from_entries'
git show "${MERGE}~1:config/whitelist.json" | jq -S "$PROG" > /tmp/wl-base.json
git show "${MERGE}:config/whitelist.json"  | jq -S "$PROG" > /tmp/wl-head.json
jq -rn --slurpfile A /tmp/wl-base.json --slurpfile B /tmp/wl-head.json \
  '[($A[0] + $B[0]) | keys[]] | unique | map(select($A[0][.] != $B[0][.])) | .[]'
```

The sync itself is on-chain-diff-driven, so a too-wide network list is harmless (extra networks no-op) — but keep the list tight so the run stays fast and the Slack post stays truthful.

## Phase 2 — Confirm plan, then execute

Present: mode, contract + version (or PR + summary), full network list, and what will be created (one timelock-wrapped Safe proposal per chain — **two** for a diamond-called periphery: registration + whitelist). Wait for explicit go-ahead before proceeding.

Set the interaction model up front: this rollout is **semi-automated** — it will pause for Ledger signing; the user comes back saying “signed”; then you verify + post Slack. Do not let them do Phases 7–8 by hand.

After confirmation:

**deploy mode** — invoke `deploy-contract`:

```text
/deploy-contract <Contract> <network...> --production
```

It deploys (CREATE3), verifies on the explorer, and registers in the diamond (`diamondCut` for facets, `diamondUpdatePeriphery` for periphery), plus the allowlist sync for diamond-called periphery. Carry forward: deployed addresses, succeeded/failed networks, allowlist sync flag. Files changed on disk are committed in Phase 5.

**propose-only mode** — run (do **not** call `deploy-contract`):

```bash
./script/tasks/proposeContractToNetworks.sh <Contract> <network...> --production
# or
./script/tasks/proposeContractToNetworks.sh <Contract> --all-where-deployed --production
```

Per-network outcomes: `OK` | `SKIP` (already-registered / duplicate-pending via Mongo `intentHash`) | `FAIL`. Continue with OK (+ note SKIPs); offer retry for FAILs. Identical pending proposals cannot be double-inserted (Mongo partial unique index); the script maps that to SKIP.

## Phase 3 — Execute sync (whitelist mode only)

deploy / propose-only already executed in Phase 2. For whitelist mode, run in the background, monitor output, report per-network results:

```bash
./script/tasks/syncWhitelistToNetworks.sh <network...> --production
```

Ends with a per-network summary and exits `1` if any network failed. Failures don't block survivors: continue with the succeeded networks, report the failed ones, and offer to retry them individually. Each proposal is created already carrying one signature (`signatureCount: 1`). A production sync automatically re-syncs staging on the same networks afterwards (staging sends directly, no proposals) — expected, not an error.

## Phase 3.5 — Deferred-cleanup drain (automatic, deploy mode)

Facet removals are **no longer proposed by hand here.** When
`DRAIN_PARKED_TASKS=true`, every production facet cut's `runPropose` call
automatically **folds** that network's **parked** facet-removal tasks (the
deferred diamond-cleanup queue) into that network's facet-cut proposal — one extra
`diamondCut` Remove element per parked facet, appended to the same timelock
`scheduleBatch`. This adds **no** extra proposal: the removals ride the facet-cut
proposal you already sign. No `cleanUpProdDiamond --auto` step is needed (design:
[docs/DeferredDiamondCleanupQueue.md](../../docs/DeferredDiamondCleanupQueue.md) §6).

- **Enable it for the rollout**: set `DRAIN_PARKED_TASKS=true` in the environment
  before Phase 2. Default **off** — keep it off for emergency / break-glass
  rollouts so unrelated removals never join an urgent signing set.
- **PR-link surfacing**: the folded removals carry the originating deprecation
  PR(s) (`parkedTaskRefs`) on the facet-cut proposal, shown at signing in
  `confirm-safe-tx` and in `list-pending-proposals` — so the signer sees **why**
  each facet is being removed.
- **Best-effort (at propose time only)**: a drain *preparation* failure never
  blocks the primary proposal or the exit code — the removals simply don't fold in.
  But once folded, the removals execute atomically inside the primary's
  `scheduleBatch`: if a folded facet is removed by another path during the timelock
  delay, its `diamondCut` Remove reverts at execution and **the whole batch — incl.
  the primary rollout cut — reverts** (docs/DeferredDiamondCleanupQueue.md §6). Keep
  `DRAIN_PARKED_TASKS` off for time-critical rollouts if that risk is unacceptable.
- **MongoDB privilege caveat**: the queue lives on the un-gated `MONGODB_URI`
  cluster (DB `deferred-cleanup`), so the drain needs no tunnel — but it does need
  the role to have `readWrite` **including index creation** on that DB. If the
  role is `createIndex`-less (the grant drifted from `timelock-operations`), the
  drain still runs (the adapter degrades non-fatally), but until an admin creates
  the `unique_open_task_key` index, **enqueue dedup is unenforced** and you may see
  a loud `DEDUP IS NOT ENFORCED` warning. Fix is infra (grant `readWrite`+index on
  `deferred-cleanup`, or create the index once). See
  [docs/DeferredDiamondCleanupQueue.md](../../docs/DeferredDiamondCleanupQueue.md) §5.
- **Cold networks** (never touched by a rollout) are caught by the standalone
  `reconcile-parked-tasks` job + TTL alert and the `cleanUpProdDiamond --auto
  --all-networks` backstop (spec §8) — not by this skill. That backstop still
  prints a conspicuous `⚠️ IRREVERSIBLE FACET REMOVAL` banner and dry-runs
  without `--yes`; use it only for a deliberate cold-network sweep. See
  [docs/FacetRemovalReconciliation.md](../../docs/FacetRemovalReconciliation.md).

## Phase 3b — Propagate per-diamond chainId mappings (PolymerCCTP, Frax)

Applies to a **`PolymerCCTPFacet`** rollout that adds a chain or CCTP corridor. The facet stores a chainId→CCTP-domain mapping per diamond, read from `config/polymercctp.json`. The *newly deployed* chain is seeded by the deploy's `initPolymerCCTP` init call, so it can route to every chain already in config the moment its cut executes — but every **already-live** chain still can't route *to* the new chain until the new chain's entry is added to their storage. `FraxFacet` has the same shape (chainId→LayerZero-EID, `config/frax.json`, `script/tasks/proposeFraxChainIdMappings.ts`) and is propagated the same way.

Two triggers:

- **New chain deployed** — rides on deploy mode. Add the new chain's `{ chainId, domainId }` to `config/polymercctp.json` **before** the deploy (so it ships in the rollout PR and the init call is consistent), then propagate it to the already-live chains after the deploy.
- **New CCTP corridor, no deploy** — standalone, whitelist-mode-like: Circle adds a domain for a chain we run no diamond on. Add the mapping to `config/polymercctp.json` and propagate only — skip the deploy (Phase 2) and the deployed-addresses PR; the `config/polymercctp.json` change ships in its own PR.

Propagate (diff-driven — proposes only where the on-chain mapping is unset or stale, so re-running is safe and a too-wide network set no-ops):

```bash
bunx tsx script/tasks/proposePolymerCCTPChainIdMappings.ts --environment production
```

The `FraxFacet` equivalent (`config/frax.json` `mappings`, chainId→LayerZero EID) is:

```bash
bunx tsx script/tasks/proposeFraxChainIdMappings.ts --environment production
```

Variants (both scripts): `--network <name>` (one chain), `--excludeNetworks '["megaeth"]'` (JSON array); the Frax script also takes `--dryRun` to print the per-network diff without proposing. Each proposal is a `LiFiTimelockController.scheduleBatch` wrapping the facet's setter (`setChainIdToDomainId` / `setFraxChainIdToEid`), created carrying one signature — same lifecycle as every other proposal here.

**Scope impact on the tail:** these proposals land on chains *beyond* the deploy target — potentially every live PolymerCCTP or FraxFacet chain. Fold them into the rest of the run — capture them in Phase 4, add their networks + nonces to the PR table in Phase 5 (and stage the config diff — `config/polymercctp.json` or `config/frax.json` — it targets `main`), verify them in Phase 7, list their networks in the Phase 8 Slack post. The runner signs them alongside the deploy proposals in Phase 6.

## Phase 4 — Capture proposals

```bash
bunx tsx script/deploy/safe/list-pending-proposals.ts --network <csv> --maxAgeHours 2 --json
```

Expect one `pending` proposal per succeeded network with `signatureCount: 1` (the signature added at creation), plus **one more** when a diamond-called periphery's allowlist synced (registration + whitelist) — so **one or two** per network. The Phase 3.5 deferred-cleanup drain adds **no** extra proposal: its removals are folded into the network's facet-cut proposal as extra `scheduleBatch` elements (visible via that proposal's `parkedTaskRefs`), so do **not** wait for or count a separate removal proposal. Targets are the chain's `LiFiTimelockController` (proposals wrap in a timelock `scheduleBatch`). Keep `nonce` per network — the PR table needs it. Missing networks here mean the propose step failed even though the deploy succeeded — investigate before continuing; a periphery network showing only one proposal means its allowlist sync didn't land.

## Phase 5 — Draft PR (deploy mode; propose-only when files dirty)

**deploy mode:** The deploy updated `deployments/<net>.json` (and staging logs if staging was deployed). If a diamond-called periphery's allowlist synced, `updateWhitelistPeriphery.ts` also rewrote `config/whitelist.json` (and `config/whitelist.staging.json`) on disk — that diff must ship in this PR too. Model the PR on #1917. Delegate to `/create-pr` (as **draft**): stage deployment logs + any whitelist diffs; body includes `| Chain | Contract address | Safe nonce |` from Phases 2 and 4.

**propose-only mode:** usually no deployment-log changes — skip the PR unless allowlist sync dirtied `config/whitelist.json` / `config/whitelist.staging.json` (then open a small PR for those). Prefer an existing deploy PR (e.g. deferred-cut PR) as the Slack link when one already has the addresses.

**whitelist mode:** no files — skip; the input PR is the Slack link.

## Phase 6 — Hand off signing (then wait for the user to come back)

This is the one step the skill cannot run itself: `confirm-safe-tx.ts` is an interactive program that drives the user's Ledger over USB, so it must run in *their* terminal. Give them (lifi-connect tunnel required; Ledger is the default signer):

```bash
bunx tsx script/deploy/safe/confirm-safe-tx.ts
```

Variants if they ask: `--network <name>` (one chain), `--ledgerLive --accountIndex <i>` (Ledger Live derivation).

Then make the hand-back contract explicit — tell the user, in these words:

> Run the command above and approve each proposal on your Ledger. **When you're done, come back to this chat and tell me "signed" (or "done").** I'll then verify the signatures and post the Slack thread for you. **Please don't post to Slack or check the signatures yourself** — those are my remaining steps (Phases 7–8); doing them by hand means I can't confirm the rollout actually completed.

Each proposal already carries one signature, so theirs makes 2 of the 3 required (the remaining signer comes from the Slack thread). Then **stop and wait** — do not proceed to Phase 7 until the user says they've signed. If they go quiet here, the rollout is **unfinished**: proposals sit at the runner's signature with no Slack ask. If the conversation resumes later with no signal either way, re-confirm by re-running Phase 7's check rather than assuming.

## Phase 7 — Verify signatures

```bash
bunx tsx script/deploy/safe/list-pending-proposals.ts --network <csv> --status all --maxAgeHours 24 --json
```

Gate, per target network: a matching proposal that is `pending` with `signatureCount >= 2` (the runner has added their signature on top of the one from creation — ready to recruit the remaining signer), or already `submitted`/`executed` (a fast signer beat the Slack post — fine, post anyway as a record). A network still at `signatureCount: 1` (or with no row) means the runner's signature didn't land — go back to Phase 6 for those. Only proceed when every network passes.

## Phase 8 — Slack thread

Channel `#dev-sc-multisig-proposals` = `C09DKGYQ1GC`. Post as two messages (format verified against the live channel):

Top-level:

```text
<N>x <Contract> v<version> deployment
```

(propose-only: `<N>x <Contract> v<version> diamond cut`; whitelist: `<N>x whitelist sync — <short PR title>`)

Thread reply (capture `ts` from the top-level; `@diamond_multisig_signers` MUST be the subteam syntax — plain text does not notify). Signing pings the multisig-signer group, not the PR-review group `@smartcontract_core` — the signer set includes a non-core member:

```text
<!subteam^S0BKA0JRY0G> please sign/execute :pray:

PR with deployed addresses: <PR URL>

Safe proposals live on:
• <network 1>
• <network 2>
…
```

(whitelist mode: label the link `Whitelist PR:` instead.)

## Phase 9 — Report

Summarize: networks rolled out (+ failures and their state), proposal nonces, PR URL, Slack thread link, and what remains (team signatures/execution; timelock ops execute via the scheduled pipeline after the delay — once they have, finish with `/finish-rollout <thread link>`).

## Failure modes

- `list-pending-proposals.ts` exits `2` → tunnel down or `SC_MONGODB_URI` missing — tell the user, retry after they fix it.
- Deploy succeeded but no proposal row → propose step failed; check the deploy log for the network, re-run that single network via `deploy-contract`.
- Propose-only SKIP duplicate-pending → identical Safe intent already pending (Mongo `intentHash`); do not treat as failure.
- Stale/future nonce warnings during signing → `confirm-safe-tx.ts` explains them inline; relay its guidance (usually: delete + re-propose via `--propose-only`, or execute the blocking nonce first).
- Slack MCP missing → give the user both message texts verbatim to post manually; do not fall back to webhooks (wrong identity).
