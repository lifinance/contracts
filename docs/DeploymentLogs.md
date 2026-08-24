# Deployment Logs

Per network, `deployments/` holds:

| File | Shape |
| --- | --- |
| `<network>.json` | flat `ContractName → address` map (facets, periphery, diamond, timelock) |
| `<network>.diamond.json` | `LiFiDiamond.Facets` keyed by address (`Name`, `Version`) plus `LiFiDiamond.Periphery` name → address |

Staging uses the `.staging.json` / `.diamond.staging.json` variants; the semantics below are
identical.

## Both files describe current state, not history

- `<network>.diamond.json` lists what the diamond **registers right now** — `Facets` is
  regenerated from the loupe, `Periphery` from one `getPeripheryContract` read per contract in
  `src/Periphery/`.
- `<network>.json` is the address book of contracts **currently in use** on that network. A
  contract deployed but not yet cut into the diamond belongs here (that is what propose-only
  registration reads); a contract whose registration was **removed** does not.

Once a facet removal has executed on-chain, drop the facet from **both** files in the same PR
that records the removal — or already at park time, once a covering parked task is open (see
below). Neither file is deployment history.

These files are the repo-side answer to "what is live on this chain right now", and are read as
such by the target-state diff, `script/deploy/healthCheckInvariants.ts`, `/verify-contracts`, the
deferred diamond-cleanup drain, and automated evaluations. A stale entry makes each of those
report on a contract that no longer exists.

Deployment history stays available without these files:

```bash
bunx tsx script/deploy/query-deployment-logs.ts history --contract <Name> --network <network>
```

plus this repo's git history for the log files themselves.

## When to prune

| Situation | Action |
| --- | --- |
| `/deprecate-contract` removed the facet from the codebase and parked its removal | both entries may go **in the deprecation PR** once the covering parked task is open (`queued`/`proposed`) — the queue-aware health-check invariants report the still-routed facet as expected-pending until the removal executes. A task retiring as **cancelled** means no removal will execute and the facet must be treated as live: restore (or keep) the entries |
| `/deprecate-contract` removed the facet from the codebase but no parked task covers a network yet | keep both entries for that network — without queue coverage the health check needs the log to map the routed address to a name, and pruning would degrade its stale-facet coverage |
| A **periphery** contract was deprecated (source deleted) | remove the flat-log entry even while the registry still resolves the name — nothing unregisters periphery on-chain, so registry residue is not liveness, and no invariant needs the mapping. The residue itself is input for a `registerPeripheryContract(name, address(0))` cleanup proposal |
| Removal executed on-chain (drain, `cleanUpProdDiamond`, or a manually executed timelock op) | remove the contract from `<network>.json` and its address entry from `<network>.diamond.json` |
| The logged address is dead but the **same name is live at another address** | correct the entry to the live address if the contract still exists in `src/`; a deprecated contract's entry is deleted, not corrected |
| Deployed but **not yet cut or registered** (pending rollout, or periphery called directly without registry wiring) | keep the flat-log entry — the flat log is the only place the pending address lives |
| Periphery replaced with a new address | nothing to prune — the deploy script overwrites the address in place |
| Network deprecated | `/deprecate-network` deletes the whole set of files |
| Flat log for an environment whose diamond was never deployed | delete the file **only after confirming the bring-up is abandoned** — no diamond on-chain, no open rollout task. A bring-up in progress keeps its flat log even before the diamond exists (lines above: deployed-ahead-of-cut entries live here) |

For facet entries the loupe decides, not the target state, and not whether the Solidity source
still exists. Periphery is asymmetric: the registry decides only for contracts still in `src/` —
a deprecated periphery entry goes regardless of registry residue (below). A contract whose source
was deleted but which is still cut **stays** in the logs unless an open parked task covers its
address (table above); a contract whose source is still in `src/` but whose logged address is no
longer routed **goes**. Confirm before pruning:

```bash
cast call <diamond> "facetAddresses()(address[])" --rpc-url "$(jq -r '.<network>.rpcUrl' config/networks.json)"
```

For a periphery entry the equivalent check is the registry, since periphery is never in the loupe:

```bash
cast call <diamond> "getPeripheryContract(string)(address)" "<Name>" --rpc-url <rpc>
```

`updateDiamondLogs` (`script/helperFunctions.sh`) rebuilds `LiFiDiamond.Facets` wholesale from
that same loupe call, so the diamond log self-heals for any network it is re-run on — which also
means a facet pruned at park time transiently reappears there until its removal executes
(cosmetic churn, not a signal to restore the flat-log entry). The flat log is append-only —
pruning it is always a manual edit.

## Reconciling a whole network (or the fleet)

Two failure modes make a bulk sweep riskier than it looks:

- **A partial RPC failure must never be read as "not live".** If any chain call for a network
  fails, leave that network **entirely** untouched and report it — otherwise a rate-limited
  `facetFunctionSelectors` call silently turns an address *correction* into a *deletion*.
- **Absence from the loupe and registry is not absence from the chain.** A facet deployed ahead
  of its cut, and a periphery contract called directly without registry wiring (`OutputValidator`),
  both answer zero to the probes above while being current. Before deleting such an entry, check
  the address for code and the name for a source in `src/` — when both are present, the entry is
  pending, not stale, unless a newer deployment of the same name supersedes it.
- **A registry hit is not proof of use — for a deprecated name it is residue.** Nothing
  unregisters periphery at deprecation, so `getPeripheryContract` keeps resolving deprecated
  contracts indefinitely. When the name still has a source in `src/`, a hit at a different
  address is a correction — rewrite the entry rather than deleting the only flat-log record of
  a live contract — but verify the resolved address's identity first by probing its dispatcher
  for the current source's selectors. A staging registry can still point at a pre-release
  prototype under a different ABI while the newer, source-matching deployment sits at the
  logged address; then the log entry stays and the **registry** is what needs fixing
  (re-register the current address). When the source is gone, the entry is removed no matter
  what the registry says.
- **An unnamed diamond-log entry is not an absent one.** `Facets` entries with `"Name": ""` exist
  on several staging diamonds, so resolving a name only through the diamond log will conclude the
  name is dead when it is merely unlabelled. Identify the address from its on-chain selectors
  instead — `getContractNameFromSelectorsInOut` (`script/deploy/safe/safe-utils.ts`) matches them
  against the `methodIdentifiers` of the compiled artifacts in `out/`, so run `forge build` first.
  Accept a name only when exactly one artifact accounts for the whole selector set; anything
  ambiguous stays untouched.

`script/tasks/checkDeploymentAddressConsistency.ts` cross-checks the two files only where a name
appears in both, so it cannot enforce this on its own: "in the flat log, absent from the diamond"
is also the legitimate shape of a contract deployed ahead of its cut. Deciding between the two
cases needs the loupe plus the pending-cut state, so pruning stays a reviewed manual step.
