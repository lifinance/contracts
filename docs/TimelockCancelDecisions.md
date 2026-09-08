# Timelock cancel decisions

How the unattended timelock runner decides what to do with a queued operation once the pre-execute
re-derivation has produced its signals: execute it, cancel it on-chain, hold it for the next pass, or
block it for an operator.

The decision itself is one pure module, `script/deploy/safe/timelock-cancel-decision.ts`, so the
policy can be read and tested without a chain, a queue, or a Safe. The signals it consumes are
produced by the pre-execute re-derivation (EXSC-701); until that lands, this module is the policy and
nothing calls it.

## Why cancelling is the last resort

A cancelled operation is gone: it has to be re-proposed and re-signed by a threshold of humans. So
the only input that reaches `cancel` is a divergence that has been _proven_ — derived from an
authoritative anchor rather than a stored value, and agreed by at least two independent providers. A
single lying endpoint, a transient RPC failure, or a check that never ran must not be able to destroy
a scheduled operation, and each of those has a named non-cancelling verdict below.

## The matrix

| Signal                                                                | Action    | Reason                            | Alert  | Retried |
| --------------------------------------------------------------------- | --------- | --------------------------------- | ------ | ------- |
| Everything verified                                                   | `execute` | `integrity-and-identity-verified` | none   | —       |
| Live code ≠ re-derived attested build, proven                         | `cancel`  | `proven-integrity-divergence`     | page   | no      |
| Recomputed operation id ≠ scheduled id, proven                        | `cancel`  | `proven-identity-divergence`      | page   | no      |
| Divergence reported from a stored value, or below the provider quorum | `block`   | `divergence-not-proven`           | page   | no      |
| Divergence proven but the runner holds no canceller role              | `block`   | `canceller-authority-missing`     | page   | no      |
| A check could not complete (RPC, record fetch, simulation)            | `hold`    | `verification-error`              | notice | yes     |
| The re-derivation has no implementation for this operation's shape    | `hold`    | `op-form-unsupported`             | page   | yes     |
| An address in the operation has no deployment record                  | `block`   | `deployment-record-missing`       | page   | no      |
| The operation would revert, below the revert threshold                | `hold`    | `would-revert`                    | notice | yes     |
| The operation would revert, threshold reached                         | `block`   | `would-revert`                    | page   | no      |
| The operation is already done, or unknown to the controller           | `block`   | `op-not-schedulable`              | notice | no      |
| Signals that form no recognised case                                  | `block`   | `unclassified-signals`            | page   | no      |

Two records, two consequences. A missing **deployment record** for an address in the calldata blocks:
nothing is wired into a diamond the deployment log does not know about. A missing **sign-time verdict
record** raises an alert and changes nothing else, because the verdict is re-derived here from
anchors and no stored value is read — blocking on it would turn a failed record write into a liveness
outage.

## Order of the checks

The order is itself the safety property, not a style choice:

1. **State guard.** An operation that is already done, or that the controller does not know about, is
   neither executed nor cancelled — `cancel` on it would revert.
2. **Proven divergence.** Before the error paths, because a proof on one leg stands even when another
   leg failed to read. An error therefore cannot suppress a cancel, and cannot cause one either.
3. **Unsupported legs**, then **errors**. Absence of a check never reads as a passing check.
4. **Missing deployment record**, then **would-revert**.
5. **Execute**, and only when all four legs are affirmative. Anything else falls to a blocking
   default, so an unforeseen combination of signals cannot execute.

## Circuit-breaker

Above two cancels in one pass the likelier cause is one bug in our own checker than that many
independent divergences, so the cancels are withheld, the operations are blocked, and a human is
paged.

That is only safe where declining to execute is itself a control. While `EXECUTOR_ROLE` is granted to
`address(0)`, anyone can execute a matured operation, so withholding a cancel would leave a
provably-divergent operation executable by a stranger. With an `open` or `unknown` executor posture
the breaker therefore pages _without_ withholding, and the cancels proceed.

## The open executor

`EXECUTOR_ROLE` is granted to `address(0)` on the production fleet, which means anyone can execute a
matured timelock operation. The grant comes from the deployment scripts:

- `script/deploy/facets/DeployLiFiTimelockController.s.sol:63` — `executors[0] = address(0);`
- `script/deploy/zksync/DeployLiFiTimelockController.zksync.s.sol:63` — same

The consequence for this matrix is the one in the section above: with an open executor, refusing to
broadcast is not a control, so cancelling is the only thing that stops a divergent operation, and it
has to win a race against any observer. Restricting the role to the runner's own wallet inverts that —
declining to execute becomes the primary control and cancelling demotes to cleanup.

**No contract change is needed to restrict it on the live fleet.** `EXECUTOR_ROLE`'s role admin is
`TIMELOCK_ADMIN_ROLE`, which the LI.FI Safe holds directly, so `revokeRole(EXECUTOR_ROLE,
address(0))` and `grantRole(EXECUTOR_ROLE, <runner wallet>)` are ordinary Safe-signed calls on each
timelock. That fleet-wide ceremony, and the deployment-script edit that stops new timelocks being
deployed open, are tracked on EXSC-872 and are not part of this module.

Cancelling, by contrast, needs no ceremony: `LiFiTimelockController` grants `CANCELLER_ROLE` to the
deployer wallet in its constructor (`src/Security/LiFiTimelockController.sol:55`, from the
`_cancellerWallet` argument that `script/deploy/resources/deployRequirements.json` resolves to
`global.json` → `deployerWallet`), and the audit behind EXSC-686 confirmed the role is held on all 66
active timelocks. `cancellerAuthority` is still an input to the matrix rather than an assumption,
because a role that was granted can be revoked.

## Reading the executor posture

`evaluateExecutorPosture(holders)` turns the timelock's own `EXECUTOR_ROLE` holders into `open` /
`restricted` / `unknown`, and is the authoritative form — a role can change after deployment. An
empty holder set reads as `unknown`, never as `restricted`.

`parseDeployScriptExecutorPosture(source)` reads the same posture out of a deployment script, which
is what a newly deployed timelock would get. The test suite runs it against both committed scripts,
so the day the ceremony's script half lands, that test says so.

## Tests

```bash
bun test script/deploy/safe/timelock-cancel-decision.test.ts
```
