---
name: Health-check invariant maintenance
description: Keep the declarative health-check invariant registry in sync when facets/periphery contracts are added, removed, or changed
globs:
  - 'src/Facets/**/*.sol'
  - 'src/Periphery/**/*.sol'
  - 'script/deploy/_targetState.json'
paths:
  - 'src/Facets/**/*.sol'
  - 'src/Periphery/**/*.sol'
  - 'script/deploy/_targetState.json'
---

## Health-check invariant registry ([CONV:HEALTHCHECK-INVARIANTS])

Every production diamond is swept daily against a fixed set of on-chain invariants
(facets deployed & registered, periphery wired correctly, ownership handed to the right
wallets/timelock, whitelist synced). Those invariants live as a single declarative array,
`HEALTH_CHECK_INVARIANTS`, in `script/deploy/healthCheckInvariants.ts` — this is the
**single edit surface**. Adding a check is appending one `{ name, description, severity,
scope, run() }` descriptor to that array; it is a registry edit, not bespoke control flow.

When you add, remove, or change a facet or periphery contract (including adding/removing
it from `script/deploy/_targetState.json`), review the registry and decide whether an
invariant must be added, adjusted, or removed. Use this checklist:

- **Facet added** → deployment + registration is already covered generically by the
  `facets-registered` invariant plus the target-state facet lists. Add a bespoke invariant
  **only** if the facet introduces a new binding, authorization, or owner relationship that
  the generic checks don't assert (e.g. it stores an address it must stay wired to, or it
  grants a wallet/role new execution rights).
- **Periphery added that binds to the Diamond / Executor / ERC20Proxy** (a new Receiver, a
  new proxy, etc.) → add a binding invariant mirroring `executor-erc20proxy-binding` /
  `receiver-executor-binding`: register the contract and its getter (for Receivers, extend
  the `RECEIVER_EXECUTOR_GETTERS` list) and assert it points at the deployed counterpart.
- **Facet added whose feature needs a companion periphery contract on the same chain** (a
  bridge facet that handles the source side while a Receiver handles destination calls) →
  declare the pairing in `config/global.json` → `facetPeripheryCouplings` instead of relying
  on anyone remembering it. The `facet-required-periphery` invariant then fails on any chain
  where the facet is live and none of the `requiresAnyOf` contracts is registered. Declare
  the coupling even when the feature is not live yet — set `notRequiredYet` with a reason and
  remove that field to activate it. Never suppress a real gap: `notRequiredOn` is for chains
  where the destination side genuinely does not apply, and every entry needs a reason.
- **Contract removed / deprecated** → remove its registry entry and any hardcoded name
  lists that reference it (e.g. drop the contract from `RECEIVER_EXECUTOR_GETTERS`, and its
  coupling from `facetPeripheryCouplings`).
- **Struct, authorization, or owner semantics changed** → adjust the affected invariant so
  its assertion still matches on-chain reality (e.g. a changed expected owner, a new
  authorized selector, a renamed getter).

If none of the above applies, no registry change is needed — but the review itself is not
optional. Edits to `healthCheckInvariants.ts` follow `200-typescript.md` (module header,
JSDoc on exports, `bunx eslint` + `bunx tsc-files --noEmit`).
