# Signing Fallback Runbook — the escape commit

How to propose and sign a production Safe transaction from the pinned pre-2.0
baseline when a check added by the Signing 2.0 work is refusing an honest
proposal and cannot be fixed forward in time.

Status: **written, not yet rehearsed.** The rehearsal against a testnet Safe
and a rehearsal store is EXSC-976 item 3, and until it runs, everything below
about how the live store behaves is read off the code rather than observed.
Treat the reconciliation step in §5 as the part most likely to need
correction.

---

## 1. What this is, and what it deliberately is not

The fallback is a **commit you check out**, never a flag you set:

| | |
|---|---|
| tag | `pre-signing-2.0-baseline` |
| commit | `49f05efa948d3bd208bbdfcf34ff70ce5eb183bf` (2026-07-24) |
| why this one | none of the 2.0 gates exist there — `assertTicketPresent`, `proposeSafeTx`, `runIntegrityAsserts` and `evaluateCodehashSignGate` are all absent from `script/` at that commit |

A `--legacy` / `SKIP_GATES` switch was refused (D26). A bypass one environment
variable away gets reached for under exactly the pressure where the gates
matter most, and every gate's threat model would then have to account for it.
Checking out a tag is deliberately slower and deliberately visible.

**Reach for this only when a gate is refusing a proposal that is genuinely
correct and the fix cannot ship in the time available.** A gate refusing a
proposal that is *wrong* is the system working. If the refusal is a false red
with a known cause, prefer fixing the gate — the fallback costs a ceremony and
leaves rows in the store that §5 has to clean up afterwards.

## 2. Check out the escape commit

```bash
git fetch origin --tags
git worktree add --detach ~/contracts-escape pre-signing-2.0-baseline
cd ~/contracts-escape
ln -s ~/Documents/GitHub/contracts/.env .env
ln -s ~/Documents/GitHub/contracts/node_modules node_modules
git submodule update --init --force --recursive
```

A worktree rather than a checkout in place: the fallback runs alongside a
normal clone, and nothing about the working repo has to be disturbed to reach
it. `--force` on the submodules is not optional — without it the command exits
0, leaves `lib/` empty, and the failure surfaces later as `ds-test not found`.

## 3. What the environment needs

Same as the normal path, and no more. The entry points are unchanged across
the gap — at both the escape commit and `main`, `bun propose-safe-tx` and
`bun confirm-safe-tx` open the tunnel via `script/deploy/safe/with-safe-tunnel.sh`
before running the TypeScript.

The variable names did not change across the gap either. Two Mongo URIs exist
and they are different stores — `SC_MONGODB_URI` holds
`sc_private.pendingTransactions`, the proposal store, at both commits, while
`MONGODB_URI` is the deployment-log and timelock-queue store. A fallback
proposal therefore lands where today's signers already look.

Confirm each required variable is **present**, by length, never by printing
it:

```bash
for v in SC_MONGODB_URI PRIVATE_KEY_PRODUCTION SAFE_SIGNER_PRIVATE_KEY; do
  eval "val=\${$v:-}"
  [ -n "$val" ] && echo "$v: set (${#val} chars)" || echo "$v: UNSET"
done
```

The proposer needs `PRIVATE_KEY_PRODUCTION`; a signer confirming from the
escape commit needs `SAFE_SIGNER_PRIVATE_KEY` (or `SAFE_SIGNER`), the same
pair the current path uses.

## 4. What the signers are told

Signers do **not** need to check out the tag. A proposal written by the escape
commit is a valid row for today's `confirm-safe-tx.ts`: the only schema
difference across the gap is the optional `provenance` block (§5), and its
declaration on `main` states that consumers must treat `undefined` as a legacy
row rather than as a clean, authorless proposal.

So tell the signers, in the channel where the ceremony is coordinated:

- this proposal was created from the escape commit, and why;
- **its provenance block will be empty in the signing prompt** — that absence
  is expected here and is not the usual "this row predates capture";
- the ticket link, which the escape commit does not record on the row, so it
  has to travel with the message instead.

That third point is the substantive loss. `assertTicketPresent` reads
`SAFE_PROPOSAL_TICKET` at propose time on `main`; at the escape commit nothing
does, so nothing binds the proposal to a ticket except what a human writes.

## 5. Reconcile afterwards

Two things are left behind by a fallback proposal.

**The row has no `provenance`.** Every other field of `ISafeTxDocument` is
identical across the gap — `provenance` is the single field `main` adds. Rows
written during the fallback are therefore indistinguishable from genuinely old
rows by shape alone, which is why the window has to be recorded: note the
first and last proposal timestamp of the ceremony on the ticket, so the rows
can be named later without guessing.

**A nonce collision is reported as something else.** `unique_inflight_safe_nonce_ci`
constrains every pending/submitted row regardless of which code wrote it, so
the database refuses a colliding nonce from the escape commit exactly as it
would from `main`. That refusal is correct. What is not correct is the
message: `main` classifies which index rejected the write
(`classifyDuplicateKeyError`), while the escape commit treats **every** E11000
as the intent-hash duplicate and prints

```text
Duplicate pending proposal detected - skipping storage.
  Intent hash: 0x…
```

before returning `null`. So during a fallback, that message means *either* a
duplicate intent *or* an in-flight nonce collision, and in both cases **no
proposal was created**. Check the Safe's in-flight nonces before concluding
the intent was already proposed.

The intent index itself is partial on `intentHash: {$exists: true}`, and the
escape commit does write `intentHash`, so rows it creates are subject to that
index normally.

## 6. When the tag has to move

Any change to the stored proposal-record schema is a **re-rehearsal trigger**.
The pinned baseline is the field set above: if a future change makes a row
written by the escape commit invalid — a required field, a changed type, an
index the old writer cannot satisfy — then the escape commit no longer works
and the tag has to move forward.

Moving it is a recorded decision on EXSC-976, never a silent retag. The new
commit must be re-checked the same way: the 2.0 gates absent from `script/`,
the entry points still reachable, and the schema diff against `main` stated.
