# Signing Fallback Runbook — the escape commit

How to propose and sign a production Safe transaction from the pinned pre-2.0
baseline when a check added by the Signing 2.0 work is refusing an honest
proposal and cannot be fixed forward in time.

Ticket: **EXSC-976** · D26.

Status: **written, not yet rehearsed.** The rehearsal against a testnet Safe
and a rehearsal store is EXSC-976 item 3, and until it runs, everything below
about how the live store behaves is read off the code rather than observed.
Treat §7 as the part most likely to need correction.

---

## 1. What this is, and what it deliberately is not

The fallback is a **commit you check out**, never a flag you set:

| | |
|---|---|
| tag | `pre-signing-2.0-baseline` |
| commit | `49f05efa948d3bd208bbdfcf34ff70ce5eb183bf` (2026-07-24) |

A `--legacy` / `SKIP_GATES` switch was refused (D26). A bypass one environment
variable away gets reached for under exactly the pressure where the gates
matter most, and every gate's threat model would then have to account for it.
Checking out a tag is deliberately slower and deliberately visible.

**Reach for this only when a gate is refusing a proposal that is genuinely
correct and the fix cannot ship in the time available.** A gate refusing a
proposal that is *wrong* is the system working. If the refusal is a false red
with a known cause, prefer fixing the gate — the fallback costs a ceremony,
freezes config as well as code (§4), and leaves rows in the store that §7 has
to clean up.

### Which side of the ceremony has to fall back

**Answer this before checking anything out.** The entire 2.0 gate layer is
absent at the baseline — `git ls-tree -r 49f05efa9 -- script/deploy/safe/
script/deploy/shared/` against the same paths on `main` is the check, and it
is what §8 tells the next person to re-run rather than trusting a list of
names — so the escape commit clears any gate. But it only clears the ones
that run on the side that checks it out:

| refusing gate | runs at | who falls back |
|---|---|---|
| `assertTicketPresent`, the `proposeSafeTx` funnel and its deploy gate | propose time | the proposer only |
| `runIntegrityAsserts`, `evaluateCodehashSignGate` | sign time, inside `confirm-safe-tx.ts` | **the signers too** |

Getting this wrong wastes the ceremony: proposing from the escape commit does
nothing for a sign-time refusal, because the signer on `main` reaches the
identical check — and the proposal is then stuck *and* carries neither
provenance nor a ticket binding. Both sign-time gates block rather than skip:
an unevaluated codehash gate becomes `blockingUnevaluatedGate()`, and a failed
integrity run leaves the run undefined, which is itself the blocking state.

## 2. Check out the escape commit

From inside your existing clone:

```bash
CLONE=~/Documents/GitHub/contracts   # wherever yours lives
git -C "$CLONE" fetch origin --tags
git -C "$CLONE" worktree add --detach ~/contracts-escape pre-signing-2.0-baseline
cd ~/contracts-escape
ln -s "$CLONE/.env" .env
ln -s "$CLONE/node_modules" node_modules
```

A worktree rather than a checkout in place: the fallback runs alongside a
normal clone, and nothing about the working repo has to be disturbed.

**Only the confirm path needs a build.** `bun confirm-safe-tx` runs
`build:typechain-and-abi` (so `forge build src`, so the `lib/` submodules);
`bun propose-safe-tx` imports nothing from `typechain/` or `out/`. If you are
proposing only, skip the next step.

```bash
git submodule update --init --force --recursive
```

`--force` is what this repo's worktrees have needed in practice — without it
the command has been observed exiting 0 and leaving `lib/` empty, and the
failure then surfaces as `ds-test not found` inside `forge build`. The
mechanism has not been pinned down, so treat the flag as the remedy and
`ls lib/forge-std` as the check.

**The `node_modules` symlink borrows `main`'s resolved versions, not the
baseline's.** That works today — the baseline's propose/confirm import closure
is `citty consola viem mongodb dotenv @lifi/tron-devkit fs path`, none of which
was dropped, and the installed `viem` still satisfies the baseline's range —
but nothing enforces it, and one `bun install` in the clone can end it. The
slower, correct alternative is a real `bun install` in the escape worktree
against the baseline's own lockfile.

## 3. What the environment needs

Both entry points load `.env` themselves — `import 'dotenv/config'` in
`propose-to-safe.ts`, `dotenv.config()` in `confirm-safe-tx.ts` — and
`with-safe-tunnel.sh` greps the repo-root `.env` directly. **None of them
reads your shell**, so checking exported variables would report everything
unset on a correctly configured worktree. Check the file, and never print a
value:

```bash
for v in SC_MONGODB_URI PRIVATE_KEY_PRODUCTION SAFE_SIGNER_PRIVATE_KEY; do
  grep -qE "^${v}=." .env && echo "$v: declared" || echo "$v: MISSING from .env"
done
```

The proposer needs `PRIVATE_KEY_PRODUCTION`; a signer needs
`SAFE_SIGNER_PRIVATE_KEY` or `PRIVATE_KEY_PRODUCTION`, which are the two
`confirm-safe-tx.ts` offers. There is no `SAFE_SIGNER` variable —
`PrivateKeyTypeEnum.SAFE_SIGNER` is an internal enum member, and the only key
names `getPrivateKey` accepts are `PRIVATE_KEY`, `PRIVATE_KEY_PRODUCTION` and
`SAFE_SIGNER_PRIVATE_KEY`.

The store is the same one either way: `SC_MONGODB_URI` holds
`sc_private.pendingTransactions` at both commits, and `MONGODB_URI` is the
deployment-log and timelock-queue store, unrelated to proposals. So a fallback
proposal lands where today's signers already look.

## 4. What the escape commit freezes besides `script/`

Checking out the tag rolls back **`config/` too**, and that is the part most
likely to bite:

- **`injective` and `sepolia` do not exist in the baseline's
  `config/networks.json`.** A fallback proposal on either is impossible from
  the escape commit; the tag has to move first (§8).
- **Seven networks the org has since dropped are still `active` there** —
  `botanix`, `moonbeam`, `sophon`, `superposition`, `swellchain`, `taiko`,
  `tronshasta`. `getNetworksToProcess()` with no `--network` returns every
  active network, so **always pass `--network`**: an unqualified run fans out
  over the baseline's 76 rather than today's 71.
- `safeAddress` is unchanged on every network both files share, which is the
  one thing that would have made this unusable.
- `config/global.json` has drifted too — diff it rather than trust this list.
  As of `b7fc074df` the baseline still names `LiFiIntentEscrowFacet` where
  `main` has `LiFiIntentEscrowFacetV2` in `coreFacets`, still carries
  `FeeCollector` in `corePeriphery`, and still approves
  `CBridgeFacet.triggerRefund` (`0x0d19e519`) in
  `approvedSelectorsForRefundWallet`. Anything reading those — a diamond cut
  in particular — is reading stale values.

## 5. Make the proposal

From the escape worktree. The baseline's `propose-to-safe.ts` requires
`--network` and `--to`, takes the payload as `--calldata` or `--calldataFile`,
signs with `--privateKey` or `--ledger`, and routes through the timelock with
`--timelock`:

```bash
bun propose-safe-tx --network <network> --to <target> \
  --calldataFile <path> --timelock
```

There is no `--ticket` flag: that gate does not exist at the baseline, which
is what §6's third bullet is about.

Record the printed `safeTxHash` and the time, first and last if there are
several. §7 needs the ceremony's window.

## 6. What the signers are told

Say, in the channel where the ceremony is coordinated:

- that this proposal was created from the escape commit, and why;
- **what the provenance line will say.** It is not blank — the signer sees
  `— not recorded (proposal predates provenance capture) —`, which in this
  case is false. The row has no provenance because the escape commit does not
  write one, not because it is old;
- the ticket link, which nothing on the row carries, so it has to travel with
  the message.

That last point is the substantive loss. The binding check on `main` is
`resolveProposalIntent` inside `storeTransactionInMongoDB` — the unbypassable
one, which runs after signing — while `assertTicketPresent` is the early exit
that saves a Ledger tap. Neither exists at the baseline, so nothing ties the
proposal to a ticket except what a human writes down.

## 7. Reconcile afterwards

**Name the rows.** Every row `main` has written since 2026-09-01 carries a
provenance block: `buildProposalProvenance` returns one unconditionally, never
throws, and yields sentinel values with the cause in `captureErrors` when
capture fails. So fallback rows are identified exactly, not approximately:

```text
{ provenance: { $exists: false }, timestamp: { $gte: ISODate("2026-09-01") } }
```

Record the ceremony window on the ticket anyway — it is what lets a reader
tell one fallback from another.

**A nonce collision is reported as something else.**
`unique_inflight_safe_nonce_ci` — keyed on `{safeAddress, network, chainId,
safeTx.data.nonce}`, partial on `status ∈ {pending, submitted}` — refuses a
colliding nonce from the escape commit exactly as it would from `main`,
because the baseline's writer sets every one of those fields. That refusal is
correct. The reporting is not.

`main` classifies which index rejected the write (`classifyDuplicateKeyError`)
and turns a nonce collision into an explicit *"Nonce … is already taken by
another in-flight proposal"*. The escape commit treats **every** E11000 as the
intent-hash duplicate:

```text
WARN  Duplicate pending proposal detected - skipping storage.
        Intent hash: 0x…
ℹ Proposal already exists - no new proposal created
```

and **exits 0**. That second line is the one an operator acts on, and in the
nonce case it is simply wrong: nothing was stored, and the intent may never
have been proposed at all. Check the Safe's in-flight nonces before believing
it.

Two smaller traps in the same area. The intent index is partial on
`{ status: 'pending', intentHash: { $exists: true } }` — the `status` half is
load-bearing, since a `submitted` row's `intentHash` is unconstrained. And
`main` recognises a legacy index name, `unique_inflight_safe_nonce`, alongside
the `_ci` one; which the live collection carries is worth confirming during the
rehearsal.

## 8. When the tag has to move

Any change to the stored proposal-record schema is a **re-rehearsal trigger**,
and so is a new network, since §4 shows config is pinned along with the code.

Moving the tag is a recorded decision on EXSC-976, never a silent retag. What
to re-establish at the candidate commit, in the order that fails fastest:

1. No 2.0 gate module is present. Check the layer, not a list of names —
   `git ls-tree -r <sha> -- script/deploy/safe/ script/deploy/shared/` against
   the same paths on `main`, so a gate added after this runbook was written
   cannot be missed by a stale list.
2. The entry points still resolve: `propose-safe-tx` and `confirm-safe-tx` in
   `package.json`, and `with-safe-tunnel.sh`.
3. The `ISafeTxDocument` field diff against `main`, stated — today it is
   `+provenance`, optional.
4. The `config/networks.json` and `config/global.json` diff against `main`,
   stated as in §4.
