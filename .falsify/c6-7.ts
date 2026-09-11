import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { DIAMOND_CUT_ABI } from '/Users/danielblaecker/Documents/GitHub/contracts/.claude/worktrees/kind-chandrasekhar-6902b2/script/deploy/shared/constants'
import {
  TIMELOCK_SCHEDULE_ABI,
  TIMELOCK_SCHEDULE_BATCH_ABI,
} from '/Users/danielblaecker/Documents/GitHub/contracts/.claude/worktrees/kind-chandrasekhar-6902b2/script/deploy/safe/timelock-abi'
import { collectDiamondCutCalls } from '/Users/danielblaecker/Documents/GitHub/contracts/.claude/worktrees/kind-chandrasekhar-6902b2/script/deploy/shared/diamond-cut-calls'
import {
  collectExecutabilityInput,
  type IExecutabilityChainReader,
} from '/Users/danielblaecker/Documents/GitHub/contracts/.claude/worktrees/kind-chandrasekhar-6902b2/script/deploy/safe/executability-collector'
import { evaluateExecutability } from '/Users/danielblaecker/Documents/GitHub/contracts/.claude/worktrees/kind-chandrasekhar-6902b2/script/deploy/safe/executability-simulation'
import { executabilityCheckResult } from '/Users/danielblaecker/Documents/GitHub/contracts/.claude/worktrees/kind-chandrasekhar-6902b2/script/deploy/safe/confirm-check-registry'

const SAFE = getAddress('0x5afe00000000000000000000000000000000face')
const TIMELOCK = getAddress('0x71e10c1000000000000000000000000000000001')
const DIAMOND = getAddress('0xd1a4000000000000000000000000000000000002')
const DIAMOND2 = getAddress('0xd1a4000000000000000000000000000000000003')
const FACET = getAddress('0xface000000000000000000000000000000000004')
const INIT = getAddress('0x1417000000000000000000000000000000000005')
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const SEL_A = '0xAABBCCDD' as Hex
const SEL_B = '0x11223344' as Hex

const cutCalldata = (opts: { init: Address; initCalldata: Hex; facet?: Address; action?: number; sels?: Hex[] }): Hex =>
  encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      [{ facetAddress: opts.facet ?? FACET, action: opts.action ?? 0, functionSelectors: opts.sels ?? [SEL_A, SEL_B] }],
      opts.init,
      opts.initCalldata,
    ],
  })

console.log('================ CLAIM 7: raw / target / caller / selectors / initCalldata ================')

// --- A: direct Safe -> diamond diamondCut
{
  const raw = cutCalldata({ init: ZERO, initCalldata: '0x' })
  const { calls, undecodable } = collectDiamondCutCalls([raw], { targets: [DIAMOND], caller: SAFE })
  const c = calls[0]!
  console.log('[direct]      raw===input:', c.raw === raw, '| target:', c.target, '(want', DIAMOND + ')', '| caller:', c.caller, '(want', SAFE + ')')
  console.log('              selectors:', c.selectors ?? c.cuts[0]!.selectors, '| initCalldata:', c.initCalldata, '| init:', c.init, '| undecodable:', undecodable)
}

// --- B: Safe -> timelock.schedule(diamond, ..., innerCut, ...)
{
  const inner = cutCalldata({ init: INIT, initCalldata: '0xdeadbeef', action: 1 })
  const outer = encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_ABI,
    functionName: 'schedule',
    args: [DIAMOND, 0n, inner, '0x' + '00'.repeat(32) as Hex, '0x' + '11'.repeat(32) as Hex, 86400n],
  })
  const { calls, undecodable } = collectDiamondCutCalls([outer], { targets: [TIMELOCK], caller: SAFE })
  const c = calls[0]!
  console.log('[schedule]    raw===inner cut bytes:', c.raw === inner, '| raw!==outer:', c.raw !== outer)
  console.log('              target:', c.target, '(want DIAMOND', DIAMOND + ')  caller:', c.caller, '(want TIMELOCK', TIMELOCK + ')')
  console.log('              selectors:', c.cuts[0]!.selectors, '| action:', c.cuts[0]!.action, '| init:', c.init, '| initCalldata:', c.initCalldata)
  console.log('              undecodable:', undecodable)
}

// --- C: scheduleBatch with two inner cuts to two different diamonds
{
  const inner1 = cutCalldata({ init: ZERO, initCalldata: '0x', sels: [SEL_A] })
  const inner2 = cutCalldata({ init: ZERO, initCalldata: '0x', sels: [SEL_B], action: 2 })
  const outer = encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [[DIAMOND, DIAMOND2], [0n, 0n], [inner1, inner2], '0x'+'00'.repeat(32) as Hex, '0x'+'22'.repeat(32) as Hex, 86400n],
  })
  const { calls } = collectDiamondCutCalls([outer], { targets: [TIMELOCK], caller: SAFE })
  calls.forEach((c, i) => {
    const want = i === 0 ? inner1 : inner2
    const wantTarget = i === 0 ? DIAMOND : DIAMOND2
    console.log(`[batch#${i}]     raw===inner${i+1}:`, c.raw === want, '| target:', c.target, '== want', wantTarget, ':', c.target === wantTarget, '| caller:', c.caller, '=== TIMELOCK:', c.caller === TIMELOCK, '| sels:', c.cuts[0]!.selectors)
  })
}

// --- D: no context supplied -> target/caller absent, not invented
{
  const raw = cutCalldata({ init: ZERO, initCalldata: '0x' })
  const { calls } = collectDiamondCutCalls([raw])
  console.log('[no context]  target:', calls[0]!.target, '| caller:', calls[0]!.caller, '| has own props:', 'target' in calls[0]!, 'caller' in calls[0]!)
}

console.log('\n================ CLAIM 6 + CLAIM 2(real): absent reads -> error, not pass ================')

const healthy = (overrides: Partial<IExecutabilityChainReader> = {}): IExecutabilityChainReader => ({
  hasCode: async () => true,
  facetAddress: async () => ZERO,          // selectors served by nobody -> Add is clean
  owner: async () => TIMELOCK,             // cut is sent by the timelock
  staticCall: async () => ({ outcome: 'succeeded' }),
  ...overrides,
})

const innerCut = cutCalldata({ init: ZERO, initCalldata: '0x', action: 0 })
const scheduled = encodeFunctionData({
  abi: TIMELOCK_SCHEDULE_ABI,
  functionName: 'schedule',
  args: [DIAMOND, 0n, innerCut, '0x'+'00'.repeat(32) as Hex, '0x'+'33'.repeat(32) as Hex, 86400n],
})

const run = async (label: string, reader: IExecutabilityChainReader) => {
  const input = await collectExecutabilityInput(
    { network: 'mainnet', safeAddress: SAFE, to: TIMELOCK, data: scheduled,
      nonce: { proposalNonce: 5, safeNonce: 5, pendingNonces: [] } },
    reader
  )
  const v = evaluateExecutability(input)
  const row = executabilityCheckResult(v, 'mainnet')
  console.log(`[${label}]`)
  console.log('   observations.available:', input.observations.available,
    '| hasCode entries:', input.observations.hasCode.size,
    '| owners:', input.observations.owners.size,
    '| selectorFacets:', input.observations.selectorFacets.size)
  console.log('   staticCall from:', input.staticCalls.results[0]?.from, 'data===inner cut:', (input as any).__,
    '| outcome:', input.staticCalls.results[0]?.outcome)
  console.log('   verdict refuses:', v.refuses, 'error:', v.error, '| errors:', v.errors.map(e=>e.slice(0,90)))
  console.log('   ledger row ->', row.status, row.anchor)
  return { input, v, row }
}

const healthyRun = await run('all reads answer', healthy())
console.log('   *** pass reachable on a real timelock-wrapped cut:', healthyRun.row.status === 'pass')

await run('hasCode read fails (undefined)', healthy({ hasCode: async () => undefined }))
await run('owner read fails (undefined)', healthy({ owner: async () => undefined }))
await run('facetAddress read fails (undefined)', healthy({ facetAddress: async () => undefined }))
await run('EVERY read fails', healthy({ hasCode: async () => undefined, owner: async () => undefined, facetAddress: async () => undefined }))
await run('staticCall reverts', healthy({ staticCall: async () => ({ outcome: 'reverted', revertReason: 'OnlyContractOwner()' }) }))
await run('staticCall errors', healthy({ staticCall: async () => ({ outcome: 'errored', errorReason: 'timeout' }) }))
await run('staticCall throws', healthy({ staticCall: async () => { throw new Error('socket hang up') } }))
await run('facet has no code', healthy({ hasCode: async (a) => getAddress(a) !== getAddress(FACET) }))
await run('owner is the Safe, not the timelock', healthy({ owner: async () => SAFE }))

// verify the static call really replays the inner cut bytes, from the timelock
{
  const seen: any[] = []
  await collectExecutabilityInput(
    { network: 'mainnet', safeAddress: SAFE, to: TIMELOCK, data: scheduled },
    healthy({ staticCall: async (c) => { seen.push(c); return { outcome: 'succeeded' } } })
  )
  console.log('\n[static call replay] from:', seen[0].from, '=== TIMELOCK:', seen[0].from === TIMELOCK,
    '| to:', seen[0].to, '=== DIAMOND:', seen[0].to === DIAMOND,
    '| data === inner cut bytes:', seen[0].data === innerCut)
}
