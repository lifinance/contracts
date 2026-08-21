# Deployment Logs

Per network, `deployments/` holds:

| File | Shape |
| --- | --- |
| `<network>.json` | flat `ContractName → address` map (facets, periphery, diamond, timelock) |
| `<network>.diamond.json` | `LiFiDiamond.Facets` keyed by address (`Name`, `Version`) plus `LiFiDiamond.Periphery` name → address |

Staging uses the `.staging.json` / `.diamond.staging.json` variants; the semantics below are
identical.

## Both files describe current state, not history

- `<network>.diamond.json` lists what the diamond **registers right now** — it is regenerated
  from the loupe.
- `<network>.json` is the address book of contracts **currently in use** on that network. A
  contract deployed but not yet cut into the diamond belongs here (that is what propose-only
  registration reads); a contract whose registration was **removed** does not.

Once a facet removal has executed on-chain, drop the facet from **both** files in the same PR
that records the removal. Neither file is deployment history.

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
| `/deprecate-contract` removed the facet from the codebase only | keep both entries — the facet is still registered on-chain, and the health check's stale-facet invariant needs the log to map that address to a name |
| Removal executed on-chain (drain, `cleanUpProdDiamond`, or a manually executed timelock op) | remove the contract from `<network>.json` and its address entry from `<network>.diamond.json` |
| The logged address is dead but the **same name is live at another address** | correct the entry to the live address; do not delete it |
| Periphery replaced with a new address | nothing to prune — the deploy script overwrites the address in place |
| Network deprecated | `/deprecate-network` deletes the whole set of files |
| Flat log for an environment whose diamond was never deployed | delete the file — nothing it lists is reachable through a diamond |

The loupe decides, not the target state, and not whether the Solidity source still exists. A
contract whose source was deleted but which is still cut **stays** in the logs; a contract whose
source is still in `src/` but whose logged address is no longer routed **goes**. Confirm before
pruning:

```bash
cast call <diamond> "facetAddresses()(address[])" --rpc-url "$(jq -r '.<network>.rpcUrl' config/networks.json)"
```

For a periphery entry the equivalent check is the registry, since periphery is never in the loupe:

```bash
cast call <diamond> "getPeripheryContract(string)(address)" "<Name>" --rpc-url <rpc>
```

`updateDiamondLogs` (`script/helperFunctions.sh`) rebuilds `LiFiDiamond.Facets` wholesale from
that same loupe call, so the diamond log self-heals for any network it is re-run on. The flat log
is append-only — pruning it is always a manual edit.

## Reconciling a whole network (or the fleet)

Two failure modes make a bulk sweep riskier than it looks, both hit during the EXSC-818 sweep:

- **A partial RPC failure must never be read as "not live".** If any chain call for a network
  fails, leave that network **entirely** untouched and report it — otherwise a rate-limited
  `facetFunctionSelectors` call silently turns an address *correction* into a *deletion*.
- **An unnamed diamond-log entry is not an absent one.** `Facets` entries with `"Name": ""` exist
  on several staging diamonds, so resolving a name only through the diamond log will conclude the
  name is dead when it is merely unlabelled. Fall back to matching the address's on-chain selector
  set against the `methodIdentifiers` of the compiled artifacts under `src/{Facets,Periphery,Security}`,
  and only accept a match when exactly one candidate contains the whole set.

`script/tasks/checkDeploymentAddressConsistency.ts` cross-checks the two files only where a name
appears in both, so it cannot enforce this on its own: "in the flat log, absent from the diamond"
is also the legitimate shape of a contract deployed ahead of its cut. Deciding between the two
cases needs the loupe plus the pending-cut state, so pruning stays a reviewed manual step.
