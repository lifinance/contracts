/**
 * That a definite red stops every action the prompt can offer before anything
 * is signed, stored or broadcast.
 *
 * Drives `createSigningFunnels`, the factory `confirm-safe-tx.ts` builds its
 * sign and execute funnels and its action dispatch from, through every action
 * `SIGNER_ACTIONS` lists, with each signer, store and broadcast dependency
 * replaced by a recorder.
 */

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  blockingUnevaluatedGate,
  proposalKeyOf,
  type ICodehashSignGate,
} from './codehash-sign-gate'
import { type IIntegrityAssertRun } from './confirm-integrity-asserts'
import { type IDefiniteRedVerdict } from './definite-red-gate'
import type {
  IAugmentedSafeTxDocument,
  ISafeTransaction,
  SafeClient,
} from './safe-utils'
import {
  buildSignerActionOptions,
  DO_NOTHING,
  SIGNER_ACTIONS,
} from './signer-action-menu'
import {
  createSigningFunnels,
  type ISigningFunnelVerdicts,
} from './signing-funnels'

const SAFE_TRANSACTION = {
  data: {
    to: '0x3333333333333333333333333333333333333333',
    value: '0',
    data: '0x8da5cb5b',
    operation: 0,
    nonce: 7,
  },
  signatures: new Map(),
} as unknown as ISafeTransaction
const KEY = proposalKeyOf(SAFE_TRANSACTION.data)

const TX_DOC = {
  safeTransaction: SAFE_TRANSACTION,
} as unknown as IAugmentedSafeTxDocument

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

const RED_REFUSAL =
  'Definite red: this transaction will not be signed or executed. Gate I: a payload reverts.'

const verdicts = (
  definiteRed: IDefiniteRedVerdict | undefined,
  overrides: Partial<ISigningFunnelVerdicts> = {}
): ISigningFunnelVerdicts => ({
  codehashGate: CODEHASH_CLEAR,
  integrityRun: INTEGRITY_CLEAR,
  definiteRed,
  ...overrides,
})

/**
 * The real factory, every dependency that reaches a key, a device, the store
 * or the chain replaced by one that records its name in `reached`.
 */
const harness = (
  current: ISigningFunnelVerdicts,
  options: { signerRejects?: boolean; deployerSigned?: boolean } = {}
) => {
  const reached: string[] = []
  const errors: string[] = []
  const client = (name: string): SafeClient =>
    ({
      signTransaction: async (tx: ISafeTransaction) => {
        reached.push(`${name}.sign`)
        if (options.signerRejects) throw new Error('rejected on the device')
        return tx
      },
      executeTransaction: async () => {
        reached.push(`${name}.client-execute`)
        return { hash: '0x' }
      },
    } as unknown as SafeClient)
  const signer = client('signer')
  const deployer = client('deployer')

  const funnels = createSigningFunnels({
    safe: signer,
    verdicts: () => current,
    broadcast: async (_tx, _doc, safeClient) => {
      reached.push(
        `${safeClient === deployer ? 'deployer' : 'signer'}.broadcast`
      )
      return true
    },
    persistSigned: async () => {
      reached.push('store.persist')
    },
    initDeployerClient: async () => deployer,
    isSignedByDeployer: () => options.deployerSigned ?? false,
    logError: (_context, error) => {
      errors.push(error instanceof Error ? error.message : String(error))
    },
  })
  return { reached, errors, funnels }
}

/** What each action reaches with every verdict clear, in call order. */
const HONEST_ROUTE: Record<string, readonly string[]> = {
  Sign: ['signer.sign', 'store.persist'],
  'Sign & Execute': ['signer.sign', 'store.persist', 'signer.broadcast'],
  'Sign and Execute With Deployer': [
    'signer.sign',
    'store.persist',
    'deployer.sign',
    'store.persist',
    'deployer.broadcast',
  ],
  Execute: ['signer.broadcast'],
  'Execute with Deployer': ['deployer.broadcast'],
}

const SIGNING_ACTIONS = SIGNER_ACTIONS.filter((action) => action !== DO_NOTHING)

describe('the action list the menu is built from', () => {
  it('holds Do Nothing and at least the five signing actions', () => {
    expect(SIGNER_ACTIONS).toContain(DO_NOTHING)
    expect(SIGNING_ACTIONS.length).toBeGreaterThanOrEqual(5)
  })

  it('has an honest route written down for every signing action', () => {
    for (const action of SIGNING_ACTIONS)
      expect(Object.keys(HONEST_ROUTE)).toContain(action)
  })

  it('offers nothing outside the list, for either kind of key', () => {
    for (const safeSigner of [false, true])
      for (const option of buildSignerActionOptions({
        refused: false,
        safeSigner,
        hasSignedAlready: false,
        wouldMeetThreshold: true,
        showSignAndExecuteWithDeployer: true,
        executable: true,
      }))
        expect(SIGNER_ACTIONS as readonly string[]).toContain(option)
  })
})

describe('a definite red stops each action before any dependency is touched', () => {
  for (const action of SIGNING_ACTIONS) {
    it(`${action}: refused, nothing signed, stored or broadcast`, async () => {
      const { reached, errors, funnels } = harness(verdicts(RED))
      const outcome = await funnels.runAction(action, TX_DOC)
      expect(reached).toEqual([])
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain(RED_REFUSAL)
      expect(outcome).toEqual({
        signatures: 0,
        signedThisRun: false,
        executedThisRun: false,
      })
    })

    it(`${action}: a verdict never taken refuses the same way`, async () => {
      const { reached, errors, funnels } = harness(verdicts(undefined))
      await funnels.runAction(action, TX_DOC)
      expect(reached).toEqual([])
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('never evaluated')
    })

    it(`${action}: a verdict about another transaction refuses the same way`, async () => {
      const { reached, errors, funnels } = harness(
        verdicts({ gradedKey: 'another', reds: [] })
      )
      await funnels.runAction(action, TX_DOC)
      expect(reached).toEqual([])
      expect(errors[0]).toContain('about a different transaction')
    })

    it(`${action}: a clear verdict reaches every dependency of its route`, async () => {
      const { reached, errors, funnels } = harness(verdicts(CLEAR))
      const outcome = await funnels.runAction(action, TX_DOC)
      expect(errors).toEqual([])
      expect(reached.length).toBeGreaterThan(0)
      expect(reached).toEqual([...(HONEST_ROUTE[action] ?? [])])
      expect(outcome.signedThisRun).toBe(reached.includes('store.persist'))
      expect(outcome.executedThisRun).toBe(
        reached.some((step) => step.endsWith('.broadcast'))
      )
    })
  }

  it('Do Nothing reaches nothing, even when every verdict is clear', async () => {
    const { reached, errors, funnels } = harness(verdicts(CLEAR))
    await funnels.runAction(DO_NOTHING, TX_DOC)
    expect(reached).toEqual([])
    expect(errors).toEqual([])
  })
})

describe('the definite-red refusal sits behind the more specific ones', () => {
  for (const action of SIGNING_ACTIONS) {
    it(`${action}: a blocking codehash verdict reports itself, not the red`, async () => {
      const { reached, errors, funnels } = harness(
        verdicts(RED, { codehashGate: blockingUnevaluatedGate() })
      )
      await funnels.runAction(action, TX_DOC)
      expect(reached).toEqual([])
      expect(errors[0]).toContain('Codehash gate:')
      expect(errors[0]).not.toContain('Definite red')
    })

    it(`${action}: an absent integrity run reports itself, not the red`, async () => {
      const { reached, errors, funnels } = harness(
        verdicts(RED, { integrityRun: undefined })
      )
      await funnels.runAction(action, TX_DOC)
      expect(reached).toEqual([])
      expect(errors[0]).toContain('Proposal integrity:')
      expect(errors[0]).not.toContain('Definite red')
    })
  }
})

describe('the verdict is read when the funnel runs, not when it is built', () => {
  it('a red adopted after the factory was built still refuses', async () => {
    const current = verdicts(CLEAR)
    const { reached, errors, funnels } = harness(current)
    current.definiteRed = RED
    await funnels.runAction('Sign', TX_DOC)
    expect(reached).toEqual([])
    expect(errors[0]).toContain(RED_REFUSAL)
  })

  it('both funnels refuse when called directly, ahead of the client', async () => {
    const { reached, funnels } = harness(verdicts(RED))
    const refusals: string[] = []
    for (const pending of [
      funnels.signTransaction(SAFE_TRANSACTION),
      funnels.executeTransaction(SAFE_TRANSACTION, TX_DOC),
    ])
      try {
        await pending
        refusals.push('')
      } catch (error) {
        refusals.push(error instanceof Error ? error.message : String(error))
      }
    expect(refusals.map((message) => message.includes(RED_REFUSAL))).toEqual([
      true,
      true,
    ])
    expect(reached).toEqual([])
  })
})

describe('every action either kind of key is offered, driven through the factory', () => {
  const everything = {
    hasSignedAlready: false,
    wouldMeetThreshold: true,
    showSignAndExecuteWithDeployer: true,
    executable: true,
  }

  for (const safeSigner of [false, true]) {
    const who = safeSigner ? 'SAFE_SIGNER key' : 'owner key'
    const offered = buildSignerActionOptions({
      ...everything,
      safeSigner,
      refused: false,
    })

    it(`${who}: is offered signing and execution while nothing refuses`, () => {
      expect(offered).toContain('Sign')
      expect(offered).toContain('Execute')
      expect(offered).toContain('Execute with Deployer')
      expect(offered).toContain('Sign and Execute With Deployer')
      expect(offered.includes('Sign & Execute')).toBe(!safeSigner)
    })

    for (const action of offered.filter((option) => option !== DO_NOTHING)) {
      it(`${who}, ${action}: a red refuses before any dependency`, async () => {
        const { reached, errors, funnels } = harness(verdicts(RED))
        await funnels.runAction(action, TX_DOC)
        expect(reached).toEqual([])
        expect(errors[0]).toContain(RED_REFUSAL)
      })

      it(`${who}, ${action}: an honest verdict reaches the signer or the chain`, async () => {
        const { reached, funnels } = harness(verdicts(CLEAR))
        await funnels.runAction(action, TX_DOC)
        expect(reached).toEqual([...(HONEST_ROUTE[action] ?? [])])
        expect(reached.length).toBeGreaterThan(0)
      })
    }

    it(`${who}: a refused proposal is offered Do Nothing alone`, () => {
      expect(
        buildSignerActionOptions({ ...everything, safeSigner, refused: true })
      ).toEqual([DO_NOTHING])
    })
  }
})

describe('past the refusals', () => {
  it('a signature the device rejects is reported, and nothing is stored', async () => {
    const { reached, errors, funnels } = harness(verdicts(CLEAR), {
      signerRejects: true,
    })
    const outcome = await funnels.runAction('Sign', TX_DOC)
    expect(reached).toEqual(['signer.sign'])
    expect(errors).toEqual([
      'Failed to sign transaction: rejected on the device',
    ])
    expect(outcome.signedThisRun).toBe(false)
  })

  it('a deployer that has already signed is not asked again', async () => {
    const { reached, funnels } = harness(verdicts(CLEAR), {
      deployerSigned: true,
    })
    await funnels.runAction('Sign and Execute With Deployer', TX_DOC)
    expect(reached).toEqual([
      'signer.sign',
      'store.persist',
      'deployer.broadcast',
    ])
  })

  it('logs to the console when no logger is injected', async () => {
    const { funnels } = harness(verdicts(RED))
    const bare = createSigningFunnels({
      safe: {} as SafeClient,
      verdicts: () => verdicts(RED),
      broadcast: async () => true,
      persistSigned: async () => undefined,
      initDeployerClient: async () => ({} as SafeClient),
      isSignedByDeployer: () => false,
    })
    expect(await bare.runAction('Execute', TX_DOC)).toEqual(
      await funnels.runAction('Execute', TX_DOC)
    )
  })
})
