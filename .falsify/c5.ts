import { decideRevertedOperation, gradeOperationIdentity } from '../script/deploy/safe/timelock-cancel-placement'
import { evaluateCancelPass } from '../script/deploy/safe/timelock-cancel-decision'

const states = ['ready', 'pending', 'done', 'unset'] as const
const auths = ['held', 'absent', 'unknown'] as const
const SCHEDULED = '0xabc123'
// Everything the executor's `recomputeOperationId` can return:
const recomputed: [string, string | undefined][] = [
  ['identical', SCHEDULED],
  ['identical-different-case', '0xABC123'],
  ['identical-padded-ws', '  0xabc123  '],
  ['different', '0xdef456'],
  ['read-failed(undefined)', undefined],
]
const attempts: [string, number][] = [['below threshold', 1], ['at threshold', 3], ['above', 9]]
const THRESHOLD = 3

const seen = new Map<string, number>()
let rows = 0
let cancels = 0
for (const operationState of states)
  for (const cancellerAuthority of auths)
    for (const [rlabel, recomputedOperationId] of recomputed)
      for (const [alabel, revertAttempts] of attempts) {
        rows++
        const d = decideRevertedOperation({
          scheduledOperationId: SCHEDULED,
          recomputedOperationId,
          operationState,
          cancellerAuthority,
          // hardcoded by the executor's call site:
          deploymentRecord: 'error',
          signTimeVerdictRecord: 'missing',
          revertAttempts,
          revertBlockThreshold: THRESHOLD,
        })
        const key = `${d.action}/${d.reason}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
        if (d.action === 'cancel') {
          cancels++
          console.log('CANCEL REACHED:', { operationState, cancellerAuthority, rlabel, alabel, d })
        }
      }

console.log(`enumerated ${rows} executor-producible inputs (${states.length} states x ${auths.length} authorities x ${recomputed.length} id reads x ${attempts.length} attempt counts)`)
console.log('outcomes:')
for (const [k, n] of [...seen.entries()].sort()) console.log(`  ${n.toString().padStart(3)}  ${k}`)
console.log('cancels reached:', cancels)

// the two hardcoded legs, isolated
console.log('\ngradeOperationIdentity outputs:', recomputed.map(([l, v]) => `${l}=${gradeOperationIdentity({ scheduledOperationId: SCHEDULED, recomputedOperationId: v })}`).join(' '))

// control: flip ONLY the two hardcoded fields and show cancel IS otherwise reachable
import { evaluateCancelDecision } from '../script/deploy/safe/timelock-cancel-decision'
const control = evaluateCancelDecision({
  integrity: 'match', opIdentity: 'mismatch', verdictProvenance: 'anchors', agreeingProviders: 2,
  executability: 'would-revert', deploymentRecord: 'present', signTimeVerdictRecord: 'present',
  operationState: 'ready', cancellerAuthority: 'held', revertAttempts: 1, revertBlockThreshold: 3,
})
console.log('control (provenance=anchors, 2 providers):', control.action, control.reason)
