---
name: Safe signing stack
description: A change to the signing gates states the signer impact before work starts
areas: [safe-signing]
requires:
  - section: Signer impact
    check: nonempty
    hint: What a signer sees differently, and which rows of docs/MultisigSigningProcess.md section 5 change
  - section: Acceptance criteria
    check: { command_matches: '^bun test script/deploy/(safe|codehash)/' }
    hint: At least one acceptance command runs the signing-stack tests, e.g. `bun test script/deploy/safe/`
---

A signer reads `docs/MultisigSigningProcess.md` to learn which checks stand between a proposal and a
signature. A ticket that changes those checks says up front what the signer will see differently, so
the doc update the repo's signing-doc rule demands is planned, not discovered in review.
