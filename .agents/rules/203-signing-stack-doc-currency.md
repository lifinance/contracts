---
name: Signing stack doc currency
description: A gate change under script/deploy/safe or script/deploy/codehash updates docs/MultisigSigningProcess.md in the same PR
globs:
  - 'script/deploy/safe/**/*.ts'
  - 'script/deploy/codehash/**/*.ts'
paths:
  - 'script/deploy/safe/**/*.ts'
  - 'script/deploy/codehash/**/*.ts'
---

## Keep the signing document current ([CONV:SIGNING-DOC])

`docs/MultisigSigningProcess.md` describes itself as current state — what **is**,
with §9 alone describing plans. A signer reads it to learn which checks stand
between a proposal and a signature, so a section that has gone stale is a wrong
answer to that question rather than a missing one, and a check described as
unbuilt while it runs is the worst shape of it.

A change under these paths updates that document **in the same PR** when it:

- adds, removes or renames a gate, or changes its letter, check id, section or class
- changes what a gate blocks, reports, acknowledges or skips — a new refusal, a
  verdict moving between `pass` / `needs-ack` / `error`, or a network or calldata
  shape falling in or out of coverage
- moves where a gate runs: the sign route, the execute route, the pre-broadcast
  observation, or the run-level ledger
- changes what the signer is shown before the action prompt

A refactor, a rename carrying no behaviour, a test-only change and a reworded
error message do not.

## Where the update lands

- §4.3 — what the signer sees, in the order the prompt shows it
- §5 "Automated checks by stage" — the gate roster, one row per check, with its
  behaviour and the module that enforces it
- §6 — what the signer must still verify by eye
- §9 — only what is genuinely unbuilt

Cite the module that implements what you write, and verify the claim against the
code rather than the surrounding prose. Something shipping out of §9 moves into
the body; it is never described in both.
