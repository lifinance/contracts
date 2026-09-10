# Signing Fallback Runbook — the escape commit

How to propose and sign a production Safe transaction from the pinned pre-2.0
baseline when a check added by the Signing 2.0 work is refusing an honest
proposal and cannot be fixed forward in time.

Ticket: **EXSC-976**, which carries the decision (D26) this runbook implements.

Status: **written, not yet rehearsed.** The rehearsal against a testnet Safe
and a rehearsal store is EXSC-976 item 3, and until it runs, everything below
about how the live store behaves is read off the code rather than observed.
Treat §7 as the part most likely to need correction. §4's inventory — which
networks, how many deployment files — is the part most likely to have gone
stale, since networks are added and retired continuously; it is dated, and §5
re-derives what it actually depends on rather than trusting it.

---

## 1. What this is, and what it deliberately is not

The fallback is a **commit you check out**, never a flag you set:

| what | value |
|---|---|
| tag | `pre-signing-2.0-baseline` |
| commit | `49f05efa948d3bd208bbdfcf34ff70ce5eb183bf` (2026-07-24) |

A `--legacy` / `SKIP_GATES` switch was refused — decision D26, recorded on
EXSC-976. A bypass one environment
variable away gets reached for under exactly the pressure where the gates
matter most, and every gate's threat model would then have to account for it.
Checking out a tag is deliberately slower and deliberately visible.

**Reach for this only when a gate is refusing a proposal that is genuinely
correct and the fix cannot ship in the time available.** A gate refusing a
proposal that is *wrong* is the system working. If the refusal is a false red
with a known cause, prefer fixing the gate — the fallback costs a ceremony,
freezes config as well as code (§4), and leaves rows in the store that §7 has
to reconcile.

**What the fallback does not weaken.** It drops the 2.0 gate layer; it does
not drop the multisig or the timelock. The baseline reads the threshold from
the Safe contract itself (`safe.getThreshold()` in `confirm-safe-tx.ts`, not
from the frozen `config/`), and offers an execute option only once
`hasEnoughSignatures` finds the collected signatures at or above it — so
quorum is enforced by the same on-chain value either way, and there is no
single-signer path. `--timelock` still wraps the call in a
`scheduleBatch` via `wrapWithTimelockSchedule`, still resolving
`LiFiTimelockController` from `deployments/` (§4 covers what being frozen
costs there). What is lost is provenance and the ticket binding, which is §6.

### Which side of the ceremony has to fall back

**Answer this before checking anything out.** At `49f05efa9` every 2.0 gate
module is absent outright — `delegatecall-gate.ts`, `codehash-sign-gate.ts`,
`confirm-integrity-asserts.ts`, `ledger-guards.ts`, `proposal-intent.ts` and
`calldata-address-check.ts` are all missing from `script/deploy/safe/`, and
all six exist on `main`. So this commit clears any gate. That is a property of
this commit, established by checking those paths — not something the §8
directory diff would have told you, which is why §8 asks a different question
of a *candidate* commit. But it only clears the gates that run on the side
that checks it out:

**The command that printed the refusal is the answer**, and it is a better
guide than any list of gate names, which will go out of date:

| the refusal appeared while running | who falls back |
|---|---|
| `bun propose-safe-tx` (or a deploy script that proposes) | the proposer only |
| `bun confirm-safe-tx` | **the signers too** |

That is a first cut, not the whole answer: **a gate can be wired on both
paths.** `evaluateDelegateCallGate` is — `confirm-safe-tx.ts` calls it
directly, and so do three methods in `safe-utils.ts`
(`signTransactionWithHash`, `signTransaction`, `executeTransaction`). The
propose path reaches it through the third of those: `propose-safe-tx.ts` calls
`safe.signTransaction()`, which asserts the gate before it signs. So grep the
refusing gate's call sites *and follow them back to an entry point* — a gate
that looks sign-only can sit behind a helper the proposer also calls, and then
both sides fall back.

Sign-time gates are the larger group and they refuse in different ways, so do
not expect a single recognisable message: `evaluateCodehashSignGate` and
`runIntegrityAsserts` both block by leaving their verdict unevaluated
(`blockingUnevaluatedGate()`, and an undefined integrity run *is* the blocking
state), `evaluateDelegateCallGate` prints `⛔ REFUSED` with its reason and then leaves
`Do Nothing` as the only option — it withdraws the execute choices as well as
the signing ones — and `evaluateTargetStateIntent` prints `✗  EXPECTED-STATE
CHECK FAILED — NOT SIGNING OR EXECUTING` and skips to the next **proposal**,
leaving the rest of the run intact.

Getting this wrong wastes the ceremony: proposing from the escape commit does
nothing for a sign-time refusal, because the signer on `main` reaches the
identical check — and the proposal is then stuck *and* carries neither
provenance nor a ticket binding.

## 2. Check out the escape commit

From inside your existing clone:

```bash
CLONE=~/Documents/GitHub/contracts   # wherever yours lives
git -C "$CLONE" fetch origin --tags

# The tag is movable by design (§8), so resolve it and stop if it is not the
# commit this runbook was written against.
EXPECTED=49f05efa948d3bd208bbdfcf34ff70ce5eb183bf
RESOLVED=$(git -C "$CLONE" rev-parse "pre-signing-2.0-baseline^{commit}")

if [ "$RESOLVED" = "$EXPECTED" ]; then
  echo "✓ tag resolves to the documented commit: $RESOLVED"
  git -C "$CLONE" worktree add --detach ~/contracts-escape "$RESOLVED"
  cd ~/contracts-escape
  ln -s "$CLONE/.env" .env
  ln -s "$CLONE/node_modules" node_modules
else
  echo "✗ STOP — tag resolves to $RESOLVED, not $EXPECTED (see §8)"
fi
```

The checkout is inside the `if` on purpose: a mismatch has to leave you with no
escape worktree at all, not with one you were told not to use.

A worktree rather than a checkout in place: the fallback runs alongside a
normal clone, and nothing about the working repo has to be disturbed.

Record the resolved SHA alongside the `safeTxHash`es of §5 — a fallback
ceremony is only reconstructable afterwards if both are on the ticket. A
mismatch is not automatically wrong (§8 is the procedure for moving the tag
deliberately); it means this runbook's §4 and §7 facts were established
against a different commit and have to be re-checked at the one you have.

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
is `citty consola viem viem/accounts mongodb dotenv @lifi/tron-devkit tronweb`
plus the Ledger packages and node builtins; none was dropped, and the installed
`viem` and `tronweb` both still satisfy the baseline's ranges.

The Ledger side deserves its own note. `@ledgerhq/hw-transport-node-hid` and
`@ledgerhq/hw-app-eth` are loaded by **dynamic import**, so a resolution
failure there surfaces at Ledger-tap time rather than at startup —
mid-ceremony, in other words. `@ledgerhq/hw-transport` itself is imported only
as a type and is declared in neither `package.json`; it resolves today as a
hoisted transitive of `hw-transport-node-hid`.

Nothing enforces any of this, and one `bun install` in the clone can end it. The
slower, correct alternative is a real `bun install` in the escape worktree
against the baseline's own lockfile.

## 3. What the environment needs

Both entry points load `.env` themselves — `import 'dotenv/config'` in
`propose-to-safe.ts`, `dotenv.config()` in `confirm-safe-tx.ts` — and
`with-safe-tunnel.sh` greps the repo-root `.env` directly, so nothing has to
be exported into your shell for the scripts to work.

**But an export still wins.** Neither call passes `override: true`, and dotenv
only fills in names that are not already in `process.env`; `getPrivateKey`
then reads `process.env[keyType]` directly. So a stale value exported earlier
in the session silently beats the file. Check both, and never print a value:

```bash
for v in SC_MONGODB_URI PRIVATE_KEY_PRODUCTION SAFE_SIGNER_PRIVATE_KEY; do
  grep -qE "^[[:space:]]*${v}=." .env \
    && echo "$v: declared in .env" || echo "$v: MISSING from .env"
done

# An export beats the file, so check the three by name — presence only, never
# the value.
[ -n "${SC_MONGODB_URI:-}" ]         && echo '  ⚠ SC_MONGODB_URI is exported here — the export wins'
[ -n "${PRIVATE_KEY_PRODUCTION:-}" ] && echo '  ⚠ PRIVATE_KEY_PRODUCTION is exported here — the export wins'
[ -n "${SAFE_SIGNER_PRIVATE_KEY:-}" ] && echo '  ⚠ SAFE_SIGNER_PRIVATE_KEY is exported here — the export wins'
```

**An exported `SC_MONGODB_URI` does more than win — it splits the two halves
apart.** `with-safe-tunnel.sh` reads the URI by grepping `.env` and never
consults the environment, so it opens the port named in the *file*, while the
script connects to the URI in the *environment*. The failure that produces is
a tunnel that comes up healthy (`✓ Safe Mongo tunnel already up`) in front of
a proposal written somewhere else. If any of the three warns above, `unset` it
and start the ceremony in a fresh shell rather than reasoning about which
value applies where.

The proposer needs `PRIVATE_KEY_PRODUCTION`; a signer needs
`SAFE_SIGNER_PRIVATE_KEY` or `PRIVATE_KEY_PRODUCTION`, which are the two
`confirm-safe-tx.ts` offers. There is no `SAFE_SIGNER` variable —
`PrivateKeyTypeEnum.SAFE_SIGNER` is an internal enum member, and the only key
names `getPrivateKey` accepts are `PRIVATE_KEY`, `PRIVATE_KEY_PRODUCTION` and
`SAFE_SIGNER_PRIVATE_KEY`. Neither entry point asks for `PRIVATE_KEY` on this
path, which is why the check above covers the other two — add it if a script
you are driving takes it.

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
- **Seven networks are still `active` there that are not active on `main`** —
  `botanix`, `moonbeam`, `sophon`, `superposition`, `swellchain`, `taiko` and
  `tronshasta`. All seven are `active` at the baseline; on `main` the first six
  are gone from `networks.json` outright and `tronshasta` is still listed but
  `inactive`. The baseline will therefore accept a `--network` the org has
  since retired, and answer with its stale addresses. `--network` is required
  by the baseline's `propose-to-safe.ts`,
  so there is no fan-out risk — the risk is that a name it accepts no longer
  means what you think.
- **`deployments/` is frozen too, and `--timelock` reads it.** The baseline's
  `propose-to-safe.ts` loads `deployments/<network>.json` whenever `--timelock`
  is passed and requires `LiFiTimelockController` in it, with a different
  message for each failure — `Deployment file not found: <path>` when the file
  is missing, `LiFiTimelockController not found in deployments for network
  <n>` when the file is there without the key. Four of the 69 shared files
  carry no `LiFiTimelockController` at either commit, so the second is
  reachable too. `injective.json` and `sepolia.json`
  do not exist at the baseline at all — the same two networks, failing a
  second way. For the 69 files both trees share, no `LiFiTimelockController`
  address drifted, so as of the date above this is a missing-network problem
  rather than a wrong-address one — which is a fact with a shelf life, and why
  §5 re-diffs the one file it will actually read.
- `safeAddress` is unchanged on every network both files share, which is the
  one thing that would have made this unusable.
- `config/global.json` has drifted too — diff it rather than trust this list.
  As of `main` at `b7fc074df` (2026-09-10) the baseline still names
  `LiFiIntentEscrowFacet` where
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

**§4 says the config is frozen; this is where that has to be paid for.**
Nothing in the baseline compares its own `config/` against `main`, so before
proposing, diff the values this run will actually resolve — for the one
network you are targeting, not the whole file:

```bash
NET=<network>

# The target network's entry, not the whole file — §4's other drift is noise here.
diff <(git show "origin/main:config/networks.json" | jq ".$NET") \
     <(jq ".$NET" config/networks.json) && echo "same: networks.json[$NET]"

# The deployment file --timelock reads.
diff <(git show "origin/main:deployments/$NET.json") "deployments/$NET.json" \
  && echo "same: deployments/$NET.json"

# global.json is not per-network, so read this one rather than expecting silence.
diff <(git show "origin/main:config/global.json") config/global.json
```

Three things make the difference between a stale value and a wrong proposal:
the network's `status` on `main` (a name the baseline accepts may be retired),
`safeAddress` (unchanged on every shared network as of `main` at `b7fc074df`,
2026-09-10 — if this one differs, stop), and `LiFiTimelockController` in the
deployment file, which
`--timelock` resolves and sends to. A difference in any of the three is a stop,
not a note: it means the baseline would address a Safe or timelock the org has
moved on from.

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

The two filters below are `mongosh` queries against
`sc_private.pendingTransactions`, through the same tunnel §3 describes.

**Name the rows.** Every row `main` has written since provenance landed
carries a provenance block: `buildProposalProvenance` returns one
unconditionally, never throws, and yields sentinel values with the cause in
`captureErrors` when capture fails. The cutover is the merge of `80c3c1bf6`,
and it is a **time of day, not a date** — rows written earlier that same
morning have no provenance and would otherwise be swept in:

```text
{ provenance: { $exists: false },
  timestamp: { $gte: ISODate("2026-09-01T09:13:19Z") } }
```

**That query does not name your rows — it names every fallback's.** It has
only a lower bound, so a second ceremony's rows are indistinguishable from the
first's, and there is nothing in a row that says which. Reconcile against the
`safeTxHash`es §5 told you to record, and touch nothing outside that set:

```text
{ safeTxHash: { $in: [ "0x…", "0x…" ] } }
```

Use the unbounded form to *find* what the recorded set missed — a proposal
whose hash never got written down is exactly the row worth knowing about — and
never as the selector for a cleanup. Record the ceremony window on the ticket
as well: it is what lets a later reader tell one fallback from another.

**A nonce collision is reported as something else.**
`unique_inflight_safe_nonce_ci` — keyed on `{safeAddress, network, chainId,
safeTx.data.nonce}`, partial on `status ∈ {pending, submitted}` — refuses a
colliding nonce from the escape commit exactly as it would from `main`,
because the baseline's writer sets every one of those fields. That refusal is
correct. The reporting is not.

On a Safe whose rows hold both address spellings — `propose-to-safe-tron.ts`
stores lowercase hex, `initializeSafeClient` stores checksummed — this is not
a rare collision but a reliable one: the index compares under collation, and
the baseline's `getNextNonce` reads **uncollated**, so it is blind to the very
row that will reject it and keeps handing back the same nonce. `main`'s read
is collated for exactly this reason.

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

The escape commit does not create that index — `getSafeMongoCollection` at the
baseline creates only `unique_pending_intent_hash`. It refuses the insert
because `main` has already created it on the live collection, which is also
why a rehearsal store has to be seeded with today's indexes to reproduce any
of this.

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

1. No 2.0 gate module is present. Get the candidates from the layer rather
   than from a list of names, so a gate added after this runbook was written
   cannot be missed:
   `git ls-tree -r <sha> -- script/deploy/safe/ script/deploy/shared/` against
   the same paths on `main`. **That diff is a candidate list, not an answer** —
   it is non-empty from 2026-07-28 onward and most of what it names is
   unrelated tooling (a prefetch cache, a selector registry, a read-only
   client). For each candidate, ask the only question that matters: does an
   entry point reach it on a path that can *refuse*? Grep its call sites in
   `propose-to-safe.ts` and `confirm-safe-tx.ts`.
2. The entry points still resolve: `propose-safe-tx` and `confirm-safe-tx` in
   `package.json`, and `with-safe-tunnel.sh`.
3. The `ISafeTxDocument` field diff against `main`, stated — today it is
   `+provenance`, optional.
4. The `config/networks.json`, `config/global.json` and `deployments/` diffs
   against `main`, stated as in §4 — a network present on `main` and missing
   from either the config or the deployment file cannot be proposed for.
5. That the escape worktree still resolves its dependencies, per §2's caveat:
   the borrowed `node_modules` is `main`'s, and a `bun install` in the clone
   can invalidate it without touching this repo.

**One case this list cannot satisfy.** The earliest signing gates —
`ledger-guards.ts` and `proposal-intent.ts` — landed **2026-09-02**. For a
network added after that date, no commit both knows the network and predates
the gates, so there is no fallback for it at all: the answer is to fix the
gate, not to move the tag. Say so on the ticket rather than retagging to
something that still carries the gate.

Both networks §4 names predate that, so a candidate exists for each
(`injective` 2026-07-31, `sepolia` 2026-08-25) — but requirement 1's diff is
non-empty at either, which is why it asks whether a candidate can refuse
rather than whether the diff is empty.
