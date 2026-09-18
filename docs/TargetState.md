# Target State

`script/deploy/_targetState.json` declares **which contracts belong on which network**.

```json
{
  "optimism": {
    "production": {
      "LiFiDiamond": {
        "AcrossFacetV3": "latest",
        "SquidFacet": "latest"
      }
    }
  }
}
```

`network → environment → diamond → contract → version`. The **key** is the statement; the
value says which version that network is allowed to run.

## The value: `latest` or a pin

| Value | Meaning |
| --- | --- |
| `"latest"` | This network follows the repo — whatever `@custom:version` the contract carries on `main`. **The normal case.** |
| `"1.2.0"` | A **pin**: this exact version must be here. Any deploy of a different version on this chain is refused, and in production so is any Safe proposal that would install one. |

A pin is read as _"this version must be here"_, never as _"this is what happens to be
deployed"_. A contract that is simply not rolled out here yet is `latest`, not a pin at its
old version — otherwise the two would be written identically and nothing could tell them
apart.

**A pin holds a network back; it cannot select an old build.** Every deploy path compiles
whatever the repo currently has (`deploySingleContract.sh` resolves the version from source),
so a pin whose version the repo has moved past can only refuse the deploy. Actually
installing an older build means checking out the ref that carries it.

## What changes the file, and what does not

- **A rollout does not touch it.** The version a network runs is `@custom:version`; rolling
  a new version out to 40 chains changes no entry.
- **A version bump does not touch it.** A minor fix that is not being rolled out yet changes
  nothing — the contract stays `latest` everywhere and the fleet simply has not caught up.
- **Adding a contract to a network** adds a key with `"latest"`.
- **Removing a contract from a network** removes the key.
- **A new network** gets a full block of `"latest"` entries.
- **Pinning a network** replaces `"latest"` with a version, deliberately, in its own PR.

`scriptMaster.sh` use case **6) Add or update contract entries in \_targetState.json** edits
entries in bulk and defaults to `"latest"`; its option **3) Add a new network with all
(not-excluded) contracts** seeds a whole network with `"latest"`. There is no generator and no
spreadsheet — the file is edited in the repo and reviewed as a diff.

## Who reads it

**Membership (the keys)** — everything that asks "what belongs here":

- `healthCheck.ts` → `deriveNonCoreFacets` → the `non-core-facets-deployed`,
  `facets-registered` and `periphery-registered` invariants.
- `diamondRemovalDiff.ts` → `getExpectedFacetNames`, used by `cleanUpProdDiamond` and the
  `no-stale-registered-facets` invariant.
- `deployAllContracts.sh` (which non-core facets a new network gets) and
  `deployPeripheryContracts.sh` (which periphery it gets).

These read `Object.keys` and ignore the value entirely.

**The version** — only two consumers, both of which refuse rather than select:

- `assertTargetStateVersionAllowed` in `script/helperFunctions.sh`, asserted inside
  `deploySingleContract.sh`. Every deploy path funnels through that function, so a pin cannot
  be bypassed by entering from another script.
- The sign-time target-state gate, `script/deploy/safe/pinned-target-state.ts`
  ([docs/MultisigSigningProcess.md](./MultisigSigningProcess.md)).

**Where a pin deliberately does not reach.** Both consumers sit on the *deploy* path and the
*production proposal* path. A direct `diamondUpdateFacet` / `diamondUpdatePeriphery` cut —
the staging and testnet route, where `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND` broadcasts without
a Safe — installs an already-deployed address and is not checked against the target state.
That is intended: staging and testnet diamonds are meant to be movable, and production is
covered by the sign-time gate.

## How the sign-time gate grades a proposal

The expected version is read at `origin/main` — never the reviewer's checkout, and never the
proposer's branch.

| Entry | Expected version | Cut installs it | Cut installs something else |
| --- | --- | --- | --- |
| `"latest"` | `@custom:version` at `origin/main` | `matches-main` — clears | older → `downgrade`, **blocks**; newer → `ahead-of-main`, clears |
| a pin | the pinned version | `matches-pin` — clears | `pinned-mismatch`, **blocks** |
| contract absent | — | `not-previously-targeted` — clears, labelled | same |
| source deleted at `origin/main` | unresolvable | — | `expected-version-unresolved`, **blocks** |

A pin is graded as **equality**, not as an ordering: a _newer_ version than the pin is still
not the version the network asked for, so it refuses too. Both fixes — correcting the pin or
correcting the proposal — are a PR to `main`, which is the point.

## Rules for editing

1. **Write `"latest"` unless you are deliberately pinning.** A pin is a decision about one
   chain and belongs in its own PR with the reason in the description.
2. **Never use JSON `null` or an empty string for "no pin".** `findContractVersionInTargetState`
   reads a `null` value as an **absent entry**, so the contract would silently drop out of
   deployment while the health check still expects it from the key. Only the string `latest`
   works.
3. **Never bump a version here to record a rollout.** The deploy logs
   ([docs/DeploymentLogs.md](./DeploymentLogs.md)) and MongoDB record what was deployed; this
   file states what is allowed.
4. **Removing a network or a contract** is done by the `/deprecate-network` and
   `/deprecate-contract` commands, which strip the entries.
5. After editing, `jq empty script/deploy/_targetState.json` must pass — `jsonChecker.yml`
   enforces it in CI, and `pinned-target-state.test.ts` additionally asserts that every value
   is `latest` or a `MAJOR.MINOR.PATCH` pin and that every declared contract still has source.
