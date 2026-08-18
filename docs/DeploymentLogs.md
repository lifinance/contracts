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
| `/deprecate-contract` removed the facet from the codebase only | keep both entries — the facet is still registered on-chain, and the drain resolves its address from the flat log |
| Removal executed on-chain (drain, `cleanUpProdDiamond`, or a manually executed timelock op) | remove the contract from `<network>.json` and its address entry from `<network>.diamond.json` |
| Periphery replaced with a new address | nothing to prune — the deploy script overwrites the address in place |
| Network deprecated | `/deprecate-network` deletes the whole set of files |

The loupe decides, not the target state. Confirm the address is gone before pruning:

```bash
cast call <diamond> "facetAddresses()(address[])" --rpc-url "$(jq -r '.<network>.rpcUrl' config/networks.json)"
```

`updateDiamondLogs` (`script/helperFunctions.sh`) rebuilds `LiFiDiamond.Facets` wholesale from
that same loupe call, so the diamond log self-heals for any network it is re-run on. The flat log
is append-only — pruning it is always a manual edit.

`script/tasks/checkDeploymentAddressConsistency.ts` cross-checks the two files only where a name
appears in both, so it cannot enforce this on its own: "in the flat log, absent from the diamond"
is also the legitimate shape of a contract deployed ahead of its cut. Deciding between the two
cases needs the loupe plus the pending-cut state, so pruning stays a reviewed manual step.
