/**
 * That a definite red stops every action the prompt can offer before anything
 * is signed or broadcast.
 *
 * `processTxs` is a closure inside `confirm-safe-tx.ts`, which calls `runMain`
 * at module scope and holds the Mongo collection, the Safe clients and the
 * prompt in its scope, so it cannot be imported or driven without moving the
 * funnels out of it. What this drives instead is every exported piece the
 * funnels are built from — `createGatedSigner`, the three refusals and the menu
 * builder — composed in the order `definite-red-gate-placement.test.ts` pins
 * them to in the source, and the action-to-funnel dispatch read out of the
 * source itself, so an action added there is driven here.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  assertCodehashSignGateAllowsSigning,
  createGatedSigner,
  proposalKeyOf,
  type ICodehashSignGate,
} from './codehash-sign-gate'
import {
  assertIntegrityAssertsAllowSigning,
  type IIntegrityAssertRun,
} from './confirm-integrity-asserts'
import {
  assertNoDefiniteRed,
  type IDefiniteRedVerdict,
} from './definite-red-gate'
import { buildSignerActionOptions } from './signer-action-menu'

const SOURCE = readFileSync(join(import.meta.dir, 'confirm-safe-tx.ts'), 'utf8')

interface ITx {
  data: {
    to: string
    value: string
    data: string
    operation: number
    nonce: number
  }
}

const TX: ITx = {
  data: {
    to: '0x3333333333333333333333333333333333333333',
    value: '0',
    data: '0x8da5cb5b',
    operation: 0,
    nonce: 7,
  },
}
const KEY = proposalKeyOf(TX.data)

const CODEHASH_CLEAR: ICodehashSignGate = {
  gradedKey: KEY,
  blocksSigning: false,
  evaluated: true,
  refusals: [],
  targets: [],
  summary: '',
}

const INTEGRITY_CLEAR = {
  gradedKey: KEY,
  registered: [],
  verdict: { hardBlocked: false, nothingGraded: false, blocking: [] },
} as unknown as IIntegrityAssertRun

const RED: IDefiniteRedVerdict = {
  gradedKey: KEY,
  reds: [{ gate: 'I', reason: 'a payload reverts' }],
}
const CLEAR: IDefiniteRedVerdict = { gradedKey: KEY, reds: [] }

interface IClient {
  name: string
  signTransaction: (tx: ITx) => Promise<ITx>
  executeTransaction: (tx: ITx) => Promise<{ hash: string }>
}

interface IFunnelCall {
  funnel: 'sign' | 'execute'
  deployer: boolean
}

/**
 * Each action's funnel calls, in the order its branch makes them.
 *
 * Read from the `if (action === '…')` branches of the source, so a branch that
 * starts calling a funnel, or stops, changes what is driven below.
 */
const dispatch = (): Map<string, IFunnelCall[]> => {
  const branches = [...SOURCE.matchAll(/if \(action === '([^']+)'\)/gu)]
  const out = new Map<string, IFunnelCall[]>()
  for (const [at, branch] of branches.entries()) {
    const start = branch.index ?? 0
    const end = branches[at + 1]?.index ?? SOURCE.indexOf('\n  }\n', start)
    const body = SOURCE.slice(start, end)
    const calls = [
      ...body.matchAll(
        /(?<![.\w])(signTransaction|executeTransaction)\(([^)]*)\)/gu
      ),
    ].map((call) => ({
      funnel:
        call[1] === 'signTransaction'
          ? ('sign' as const)
          : ('execute' as const),
      deployer: /deployerSafe/u.test(call[2] ?? ''),
    }))
    out.set(branch[1] as string, calls)
  }
  return out
}

const harness = (definiteRed: IDefiniteRedVerdict | undefined) => {
  const reached: string[] = []
  const client = (name: string): IClient => ({
    name,
    signTransaction: async (tx) => {
      reached.push(`${name}.sign`)
      return tx
    },
    executeTransaction: async () => {
      reached.push(`${name}.execute`)
      return { hash: '0x' }
    },
  })
  const signer = client('signer')
  const deployer = client('deployer')

  const sign = createGatedSigner<[ITx, IClient?], ITx>({
    gate: () => CODEHASH_CLEAR,
    keyOf: (tx) => proposalKeyOf(tx.data),
    sign: async (tx, using = signer) => {
      assertIntegrityAssertsAllowSigning(
        INTEGRITY_CLEAR,
        proposalKeyOf(tx.data)
      )
      assertNoDefiniteRed(definiteRed, proposalKeyOf(tx.data))
      return using.signTransaction(tx)
    },
  })
  const execute = async (tx: ITx, using: IClient = signer) => {
    assertCodehashSignGateAllowsSigning(CODEHASH_CLEAR, proposalKeyOf(tx.data))
    assertIntegrityAssertsAllowSigning(INTEGRITY_CLEAR, proposalKeyOf(tx.data))
    assertNoDefiniteRed(definiteRed, proposalKeyOf(tx.data))
    return using.executeTransaction(tx)
  }

  const run = async (calls: readonly IFunnelCall[]): Promise<void> => {
    for (const call of calls) {
      const using = call.deployer ? deployer : signer
      if (call.funnel === 'sign') await sign(TX, using)
      else await execute(TX, using)
    }
  }
  return { reached, run }
}

/** The refusal a run ended on, or the empty string when nothing refused. */
const refusalOf = async (pending: Promise<void>): Promise<string> => {
  try {
    await pending
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const SIGNING_ACTIONS = [
  'Sign',
  'Sign & Execute',
  'Sign and Execute With Deployer',
  'Execute',
  'Execute with Deployer',
]

describe('every sign and execute action reaches a funnel', () => {
  it('reads a funnel call out of each action branch', () => {
    const table = dispatch()
    for (const action of SIGNING_ACTIONS)
      expect(table.get(action)?.length ?? 0).toBeGreaterThan(0)
    expect(table.get('Sign and Execute With Deployer')).toEqual([
      { funnel: 'sign', deployer: false },
      { funnel: 'sign', deployer: true },
      { funnel: 'execute', deployer: true },
    ])
    expect(table.get('Execute with Deployer')).toEqual([
      { funnel: 'execute', deployer: true },
    ])
  })
})

describe('a definite red stops each action before the client is touched', () => {
  const table = dispatch()

  for (const action of SIGNING_ACTIONS) {
    it(`${action}: refused, nothing signed or broadcast`, async () => {
      const { reached, run } = harness(RED)
      expect(await refusalOf(run(table.get(action) ?? []))).toContain(
        'Definite red: this transaction will not be signed or executed. Gate I: a payload reverts.'
      )
      expect(reached).toEqual([])
    })

    it(`${action}: a verdict never taken refuses the same way`, async () => {
      const { reached, run } = harness(undefined)
      expect(await refusalOf(run(table.get(action) ?? []))).toContain(
        'never evaluated'
      )
      expect(reached).toEqual([])
    })

    it(`${action}: a clear verdict reaches every client call the branch makes`, async () => {
      const { reached, run } = harness(CLEAR)
      const calls = table.get(action) ?? []
      await run(calls)
      expect(reached).toEqual(
        calls.map(
          (call) =>
            `${call.deployer ? 'deployer' : 'signer'}.${
              call.funnel === 'sign' ? 'sign' : 'execute'
            }`
        )
      )
    })
  }
})

describe('a refused proposal is offered no action that reaches a funnel', () => {
  const everything = {
    hasSignedAlready: false,
    wouldMeetThreshold: true,
    showSignAndExecuteWithDeployer: true,
    executable: true,
  }

  for (const safeSigner of [false, true]) {
    const who = safeSigner ? 'SAFE_SIGNER key' : 'owner key'

    it(`${who}: Do Nothing alone`, () => {
      expect(
        buildSignerActionOptions({ ...everything, safeSigner, refused: true })
      ).toEqual(['Do Nothing'])
    })

    it(`${who}: the same proposal unrefused offers signing and execution`, () => {
      const offered = buildSignerActionOptions({
        ...everything,
        safeSigner,
        refused: false,
      })
      expect(offered).toContain('Sign')
      expect(offered).toContain('Execute')
      expect(offered).toContain('Execute with Deployer')
      expect(offered).toContain('Sign and Execute With Deployer')
      expect(offered.includes('Sign & Execute')).toBe(!safeSigner)
      for (const option of offered)
        if (option !== 'Do Nothing') expect(SIGNING_ACTIONS).toContain(option)
    })
  }
})
