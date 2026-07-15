# The `contracts-tron` Fork

This guide has two parts: **Part 1** explains why Tron runs off a dedicated
`contracts-tron` fork and how to keep it in sync with this repo (`contracts`);
**Part 2** is the operational how-to for deploying contracts to Tron — read
Part 1 first, since you deploy _from_ the fork and the repo situation is
prerequisite context. For general Tron-vs-EVM technical reference (address
formats, fees, TronWeb code samples), see the internal Tron Datasheet linked
from the SC team's knowledge base.

## Part 1 · Why the fork exists & how to keep it in sync

`contracts-tron` is a **true GitHub fork** of this repo that exists solely so
Tron can ship a USDT-safe token-transfer path. It carries a small, deliberate
delta on top of `main`; it is an **overlay, not an independent codebase**.

### Why the fork exists

**Root cause — Tron USDT is a broken ERC-20.** Tron USDT is a legacy
Solidity `^0.4.18` contract (`StandardTokenWithFees`). It overrides
`transfer` and declares `returns (bool)` but forgets the actual `return`
statement. The EVM then returns the zero-value (32 bytes of `0x00`).
Solady's `SafeTransferLib.safeTransfer` reverts when returndata size is
`> 0` **and** the decoded value is `0` — so every direct `transfer` of Tron
USDT reverts with `TransferFailed`. (`transferFrom` on the same token _does_
include its return statement, which is why bridges using `transferFrom` —
AllBridge, Symbiosis — are unaffected.)

This broke every already-deployed contract that sends tokens via Solady
`safeTransfer`: `WithdrawFacet`, `GenericSwapFacet`, `GenericSwapFacetV3`,
`Executor`, `FeeCollector`, `TokenWrapper`, `FeeForwarder` (via
`WithdrawablePeriphery`), and `NEARIntentsFacet`. USDT is effectively **all**
Tron volume, and this specifically blocked NEAR Intents — our only
competitively-priced route from Tron to BTC and ETH mainnet, which earns
fees at the bridge level.

**Approaches weighed:**

- **`LibAsset` chain-gate on all chains** — add a `block.chainid == TRON`
  branch inside `LibAsset.transferERC20`. Single place, but ships Tron-only
  logic (and ~20 gas overhead) to 60+ other chains and sets a
  network-specific precedent in shared code.
- **`SafeTransferLibWrapper`** — a wrapper lib swapped in everywhere
  `safeTransfer` is used. Minimal change, but scatters the concern and
  leaves many direct-`safeTransfer` call sites.
- **Fork (`contracts-tron`)** — keep `main` completely free of Tron logic;
  hold the Tron-specific transfer behavior in a fork used only for Tron
  deploys.

**Decision — a hybrid.** Two independent moves:

1. In **this repo's `main`**: standardize ERC-20 transfers to route through
   `LibAsset` (removing scattered direct `safeTransfer` calls) — a
   codebase-consistency win that is _not_ Tron-specific and is now
   CI-enforced by `enforceLibAssetRouting.yml`. `main` contains **no** Tron
   branching.
2. In **`contracts-tron`**: the actual Tron USDT-safe behavior lives _only_
   here — a bypass branch in `LibAsset.transferERC20` plus a
   `WithdrawablePeriphery` re-route (see the delta below).

Rationale for the fork over the all-chains gate: no Tron-only gas/precedent
burdening 60+ chains, `main` stays clean, the fork's diff stays small and
Tron-scoped, and "is this contract Tron-ready?" becomes an explicit property
of the fork rather than an unanswerable question in `main`.

### What actually differs in the fork (the delta)

The fork stays close to upstream, but the delta is more than one line:
**~17 files across 6 categories** (verified by a clean upstream→fork merge
of 69 commits with **zero conflicts**, then diffing the fully-synced tree
against `main`). Everything here is Tron-enablement, CI, test, config or
audit — **no product features**.

- **Source (2)** — `LibAsset.sol` → **`2.1.3-tron`**: adds `TRON_CHAIN_ID`
  (`728126428`) and `TRON_USDT` constants plus a bypass branch in
  `transferERC20` that, _for that one token on Tron only_, calls
  `IERC20(assetId).transfer(recipient, amount)` and returns — skipping the
  Solady return-value check that the broken token trips.
  `WithdrawablePeriphery.sol` → **`1.0.0-tron`**: drops the upstream
  `TODO(EXSC-241)` deferral and routes `withdrawToken` through
  `LibAsset.transferAsset` (so withdrawals inherit the bypass), adding a
  `ZeroAmount` check. First landed in `contracts-tron` PR #9 / EXSC-315.
- **Tests (5)** — new `MockTronUSDT.sol` (mimics the missing-return
  behavior), added `LibAsset.t.sol` and `WithdrawablePeriphery.t.sol` cases,
  and minor tweaks to the ReceiverAcrossV3/V4/OIF/StargateV2 tests.
- **CI (3)** — `olympixStaticAnalysis.yml` (skip files identical to
  upstream), `versionControlAndAuditCheck.yml` (accept the `-tron` version
  suffix and skip the audit-commit-association check on `sync/upstream-*`
  PRs), and `verifyCommitsSigned.yml` **removed** (upstream squash-merges
  break the signed-commit chain downstream).
- **Agent rules (2)** — `100-solidity-basics.md` documents the `-tron`
  versioning overlay; `400-solidity-tests.md` uses a Tron test-naming
  example.
- **Config (1)** — `config/networks.json`: `somnia.skipHealthcheck = true`
  (see the sync-pain section below).
- **Audit (2)** — `auditLog.json` entries for `LibAsset 2.1.3-tron` and
  `WithdrawablePeriphery 1.0.0-tron`, plus the
  `2026.05.22_TronCanonicalUSDT(Part-2).pdf` report.

If a change lands only in `contracts-tron` and grows beyond this shape,
stop and reconsider — it almost certainly belongs here in `main` instead
(this doc included: it lives here so it flows to the fork through the
normal sync rather than becoming its own untracked delta item).

### Repo roles — when to use which

|                          | `lifinance/contracts` (this repo, upstream)                              | `lifinance/contracts-tron` (fork)                                 |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Purpose**              | Source of truth. All feature dev, all audits, all non-Tron deployments.    | **Only** for deploying to Tron with the USDT-safe transfer path.   |
| **Feature development**  | Yes — everything starts here.                                              | **Never.** No independent feature work.                            |
| **Relationship**         | —                                                                           | Overlay on top of `main`; pulls from it, never pushes back.        |

**Production deploy rule (unchanged):** production is deployed only from the
`main` branch of the respective repo. A Tron production deploy therefore
runs from `contracts-tron`'s `main`.

### Versioning rules (audit traceability)

Audits are keyed by `ContractName` + `@custom:version`, so **one version
must map to exactly one bytecode**. The fork uses a `-tron` overlay scheme:

- Contract identical to `main` → **same version** (e.g. `2.1.3`).
- Contract differs in the fork → **`<main-version>-tron`** (e.g.
  `2.1.3-tron`).
- Multiple Tron-only iterations against the same `main` baseline → append a
  revision: `2.1.3-tron-r2`, `2.1.3-tron-r3`.
- Only move to `2.2.0-tron` once `main` is actually at `2.2.0` **and** the
  fork has synced to that baseline (never imply a `main` version that
  doesn't exist yet).
- GitHub Actions were adjusted to accept versions beyond the plain
  `{X.Y.Z}` shape.

**Deployed ↔ repo drift:** we deliberately accept that the repo can diverge
from already-deployed bytecode (we do not re-deploy every contract on every
chain for a non-functional change). To keep re-verification possible, the
git commit hash is stored in the deploy log / MongoDB (EXSC-330) — re-verify
by checking out that exact commit, with no dependency on `main` still
matching deployed bytecode.

### Sync mechanism — direction, order, when to update which

**Direction:** one-way for code, `contracts` → `contracts-tron`. The fork
pulls from this repo; it never pushes code back to `main`. Deploy logs are
the explicit exception — they round-trip back upstream (see Part 2) and
then flow back down through the normal sync.

**Current process (PR-based):** a periodic sync PR is opened on
`contracts-tron` from a `sync/upstream-YYYY-MM-DD` branch that merges
`upstream/main` (this repo) into the fork's `main`. Review the (usually
tiny) _real_ diff, then merge. Recent examples: `contracts-tron` #13 (May)
and #15 (June, 192 commits). Merge conflicts are rare because the fork's
delta is so small.

**When to update which — the order:**

1. **Feature / fix** → land it in **this repo's `main`** first (normal PR +
   audit + merge).
2. **Tron deploy** → sync the fork from this repo's `main`, ensure the
   `-tron` delta is intact, then deploy from the fork's `main`. Deploy logs
   from that deploy are PR'd back to **this repo** (not the fork) and then
   sync back down — see
   [Part 2](#part-2--deploying-to-tron).
3. **A contract that has a `-tron` variant** → update **both** repos, this
   repo first, then the fork (bumping the `-tron` version).

**CI carve-outs on sync PRs:** to keep routine sync PRs low-noise, sync PRs
skip the audit-commit-association check and skip Olympix for files
identical to upstream.

### ⚠️ The main pain — required-check noise on sync PRs

The biggest recurring headache on the fork side: **required checks and
network healthchecks fire on sync PRs and block them on failures that have
nothing to do with the fork.**

Concrete example that blocked sync PR #13: an unrelated upstream commit
changed the _expected_ `ERC20Proxy` owner across networks from the Safe to
the `refundWallet`. On `somnia` (newly added via that sync) the on-chain
owner was still the Safe, so the healthcheck failed — on a PR that
introduced **zero** fork-authored code. Short-term fix: set the existing
`skipHealthcheck` flag for `somnia` in `config/networks.json` on the fork
(temporary).

**General class:** any required check keyed to on-chain / production state
will fire on sync PRs. A new dev should expect this and **verify the real
diff rather than chase the healthcheck noise.**

### Planned / target state (WIP)

To remove the required-check pain on routine syncs, the plan is a dedicated
GitHub App with pull-request-mode bypass in the org's branch-protection
bypass list for the fork's `main`. A scheduled job:

1. Fetches `upstream/main` (this repo) and merges it into the fork's `main`
   locally.
2. **No conflicts** → pushes the merge commit **directly** to the fork's
   `main` — no PR, no required checks. Branch protection still applies to
   humans; only the app bypasses.
3. **Conflicts** → pushes to a `sync/upstream-YYYY-MM-DD` branch and opens a
   PR for human resolution (the only path that produces a PR).

This reserves reviewer attention for genuine conflicts. WIP on the
`feat/sync-upstream-workflow` branch (in `contracts-tron`).

### New-dev gotchas (quick checklist)

- **Never** develop features in `contracts-tron`. Everything starts here in
  `contracts`.
- Deploy to Tron **only** from the fork's `main` branch.
- Keep the fork delta minimal. If this repo refactors `LibAsset` or
  `WithdrawablePeriphery`, re-check that the Tron `transferERC20` bypass and
  the `withdrawToken` re-route still apply cleanly on the fork.
- On sync PRs, unrelated required-check / healthcheck failures are
  **expected** — confirm the real diff is clean; don't fix on-chain state
  to satisfy a sync PR.
- Watch versioning: one `@custom:version` ↔ one bytecode. Use `-tron` /
  `-tron-rN` for anything that differs.

## Part 2 · Deploying to Tron

### Prerequisites — funding the deployer wallet

Tron deployments cost TRX (for Energy + Bandwidth — see
[Tron resource model](#tron-resource-model-energy--bandwidth) below). To get
funds onto Tron, bridge in via the
[Symbiosis Bridge](https://app.symbiosis.finance/bridge).

### The end-to-end deploy flow

Deploying to Tron is a **round-trip between the two repos**. The key rule:
**deploy logs are committed here, in this repo, never to the fork** — the
fork receives them back through the normal sync. This keeps this repo the
single source of truth for deploy logs on every chain, Tron included.

1. **Sync the fork first.** On `contracts-tron`, bring `main` up to date
   with this repo's `main` — merge the pending
   `sync/upstream-YYYY-MM-DD` PR (or open one) if this repo added or
   updated the contract about to be deployed. (See
   [Sync mechanism](#sync-mechanism--direction-order-when-to-update-which)
   above.)
2. **Deploy from `contracts-tron`.** With the fork synced, run the Tron
   deploy scripts (see
   [Running the deployment scripts](#running-the-deployment-scripts)
   below) from that repo. This writes the deploy logs —
   `deployments/tron.json` and `deployments/tron.diamond.json` — in that
   working tree.
3. **PR the deploy logs back here, not to the fork.** Open a PR with the
   updated deploy logs directly against `lifinance/contracts` `main` — _not_
   against `contracts-tron`. Authoring the PR against this repo directly is
   why the fork still never "pushes back": the logs land in the canonical
   repo, not via a fork branch.
4. **Let the logs flow back to the fork.** Once merged here, those deploy
   logs reach `contracts-tron` on the next upstream→fork sync PR (step 1 of
   the next deploy).

### Why Tron needs custom deploy scripts

Tron requires custom deployment scripts because Foundry doesn't support it
natively. All Tron deployment scripts live in `script/deploy/tron/` (on the
`contracts-tron` fork — they are part of the `-tron` delta and are only
runnable there since they need the fork's USDT-safe contracts).

### Tech stack: TypeScript + TronWeb

**TypeScript**

- All Tron deployment scripts are written in TypeScript
- Executed using the `bun` runtime for fast execution
- Type definitions in `script/deploy/tron/types.ts` provide compile-time
  safety
- Async/await pattern used throughout for handling blockchain interactions

**TronWeb**

- Official Tron JavaScript SDK (equivalent to ethers.js/web3.js for
  Ethereum)
- Version: 6.0.0 (see `package.json`)
- Handles wallet management, transaction signing, and contract interaction
- Requires a post-install patch for compatibility
  (`script/troncast/postinstall-tronweb-fix.mjs`)
- Key differences from ethers.js:
  - Uses Base58 addresses natively
  - Different transaction structure and signing process
  - Built-in support for Tron's resource model (Energy/Bandwidth)

### Directory structure (on `contracts-tron`)

```plain text
script/deploy/tron/
├── TronContractDeployer.ts             # Core deployment class
├── constants.ts                        # Network configs and addresses
├── types.ts                            # TypeScript type definitions
├── utils.ts                            # Helper functions
├── deploy-core-facets.ts               # Deploys Diamond pattern facets
├── register-facets-to-diamond.ts       # Registers facets to Diamond
├── deploy-and-register-periphery.ts    # Periphery contracts
├── deploy-and-register-symbiosis-facet.ts # Bridge facets
└── deploy-and-register-allbridge-facet.ts
```

The `.agents/rules/202-tron-scripts.md` rule on `contracts-tron` documents
the TypeScript conventions that apply to everything under
`script/deploy/tron/**` and `script/troncast/**`.

### Tron resource model: Energy & Bandwidth

**Energy vs gas**

- **Energy**: Tron's equivalent to Ethereum gas, consumed by smart contract
  execution.
- **Cost**: 1 Energy = **100 SUN** (0.0001 TRX) since TRON governance
  Proposal #104 (Aug 2025); it was 210 SUN before that and 420 SUN
  earlier. This is a live governance parameter — always confirm the
  current value via the `getEnergyFee` key in
  `wallet/getchainparameters` before quoting deployment costs.
- **Free Energy**: Users can stake TRX to get free daily Energy allocation
  (avoids TRX fees).
- **Contract deployment**: roughly **200 Energy per byte** of deployed
  bytecode — so ~175k Energy for the tiny Diamond proxy up to ~2.3M for
  a large facet, averaging ~1M per contract (measured against the live
  `tron` diamond, 2026-07). At 100 SUN that is ~18–230 TRX per contract.
  A full ~24-contract diamond deploy ≈ ~26M Energy (~2,600 TRX) for
  energy, plus ~230 TRX bandwidth and ~350 TRX for the
  diamondCut/registration calls — roughly **3,000–3,200 TRX (~$1,000 at
  $0.33/TRX)** all-in.

**Bandwidth**

- **Purpose**: Covers transaction size costs (bytes transmitted over
  network).
- **Cost**: 1 Bandwidth = 1000 SUN (0.001 TRX) when paying with TRX.
- **Free Bandwidth**: Every account gets 600 free bandwidth daily, more
  available through staking.
- **Usage**: Simple TRX transfers use ~250 bandwidth, contract calls use
  more based on data size.

Both resources can be obtained free through staking or paid for with TRX at
transaction time.

### Energy staking & delegation (timelock ops)

Per-deploy energy is rented (see [Prerequisites](#prerequisites--funding-the-deployer-wallet)
and the Tron Datasheet), but our **ongoing Tron timelock operations** are
funded by **delegated Energy from staked TRX**, so we don't burn TRX on
every transaction. Two wallets do the work — addresses live in
`config/global.json` → `tronWallets` on the fork (**always treat that file
as the source of truth**, do not hard-code addresses):

- **`deployerWallet`** — runs `scheduleBatch` (~53–54k energy/tx) and
  deploys contracts. Deployment energy is bought from a rental service, so
  it is **not** funded by delegation.
- **`devWallet`** — runs `executeBatch` (~230–360k energy/tx). Executions
  are now run from here, and this is the expensive operation.

**Delegation split — favour the dev wallet.** Because `executeBatch` costs
~4–6× more energy than `scheduleBatch`, the bulk of delegated energy must
sit on `devWallet`. Target roughly an **80/20 split in favour of
`devWallet`** (~110k energy on `deployerWallet` is enough for scheduling).
If most delegation sits on the deployer wallet instead, `executeBatch` falls
back to burning TRX — historically ~$8–12 per execute.

**Topping up TRX / delegation.** The `automate-wallet-dev-fees` repo does
**not** support Tron, so Tron top-ups and energy delegation are arranged by
pinging **Max** directly. Typical flow: Max funds and delegates energy to
our Tron wallets; TRX can be moved `deployerWallet` → `devWallet` as needed.
Always re-check the split after a top-up, and **after any wallet rotation
re-point the delegation at the current `config/global.json` →
`tronWallets` addresses** (stale delegation on retired wallets is wasted).

### The TronContractDeployer class

`TronContractDeployer.ts` is the core deploy engine: it estimates
Energy/Bandwidth and TRX cost before deploying, retries on network failures,
and waits for on-chain confirmation. Every `deploy-and-register-*.ts` script
follows the same shape — read network config, initialize the deployer, read
the Forge artifact, deploy, update the deployment file — so the fastest way
to write a new one is to copy an existing script rather than build the
pattern from scratch (see [Adding a new contract](#adding-a-new-contract)).
Read the class and an existing script directly for exact interfaces; they're
not reproduced here to avoid this doc drifting out of sync with the code.

### Running the deployment scripts

Run these from a `contracts-tron` checkout, not this repo:

```bash
# Set environment
export NETWORK=tron  # or tron-shasta for testnet
export PRIVATE_KEY=your_64_char_hex_key_without_0x

# Deploy in order
bun script/deploy/tron/deploy-core-facets.ts
bun script/deploy/tron/register-facets-to-diamond.ts
bun script/deploy/tron/deploy-and-register-periphery.ts
bun script/deploy/tron/deploy-and-register-symbiosis-facet.ts
```

### TronCast — a Cast-like CLI for Tron

Located in `script/troncast/` on the fork, see that repo's
`script/troncast/README.md` for the full command reference. In short:

```bash
# Read contract
bun troncast call <address> "functionName() returns (type)" --env mainnet

# Send transaction
bun troncast send <address> "functionName(type)" <args> --private-key KEY
```

Used for post-deployment verification and testing.

### Contract verification (Tronscan)

Tron uses Tronscan instead of Etherscan:

- **Mainnet**: <https://tronscan.org>
- **Testnet (Shasta)**: <https://shasta.tronscan.org>

Verification process:

1. Navigate to contract address on Tronscan.
2. Click "Contract" tab.
3. Click "Verify and Publish".
4. Select compiler version (check `foundry.toml`).
5. Upload flattened source (use `forge flatten`).
6. Provide constructor arguments (ABI-encoded).

Tronscan API endpoints (from `config/networks.json`):

- Mainnet: <https://apilist.tronscan.org/api>
- Testnet: <https://api.shasta.tronscan.org/api>

### Adding a new contract

1. Write the Solidity contract in `src/Facets/` or `src/Periphery/` here,
   in this repo (see [Repo roles](#repo-roles--when-to-use-which)), and
   compile with `forge build`.
2. Create a deployment script on `contracts-tron` in `script/deploy/tron/`
   by copying an existing script as a template — update the contract name
   and constructor args, following the naming convention
   `deploy-and-register-[name].ts`.
3. Follow [the end-to-end deploy flow](#the-end-to-end-deploy-flow) above:
   sync the fork, run the script, verify on Tronscan, then PR the updated
   deploy logs back here.

## References & resources

**Tickets:** EXSC-241 (fix Tron USDT transfers), EXSC-315 (`contracts-tron`
USDT bypass — PR #9), EXSC-330 (store git commit hash in deploy logs),
EXSC-299 (GenericSwapFacet v1 deprecation), EXSC-575 (this doc).

**PRs:** [`contracts` #1715](https://github.com/lifinance/contracts/pull/1715)
(LibAsset routing + Tron work); `contracts-tron`
[#9](https://github.com/lifinance/contracts-tron/pull/9),
[#13](https://github.com/lifinance/contracts-tron/pull/13),
[#15](https://github.com/lifinance/contracts-tron/pull/15).

**External resources:**

- **Tron Documentation**: <https://developers.tron.network/>
- **TronWeb SDK**: <https://tronweb.network/>
- **Tronscan API**: <https://apilist.tronscan.org/api>
