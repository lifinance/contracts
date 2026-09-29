// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  createCheckLedger,
  recordCheck,
  summariseLedger,
  type ICheckDefinition,
  type ICheckResult,
} from './check-ledger'
import { RPC_QUORUM_CHECK, RPC_QUORUM_CHECK_ID } from './confirm-check-registry'
import {
  CHECK_SAFE_ADDRESS,
  CHECK_SAFE_TX_HASH,
  CHECK_SIGNATURES,
  CHECK_TIMELOCK_DELAY,
  INTEGRITY_CHECK_DEFINITIONS,
  type IIntegrityAssertRun,
} from './confirm-integrity-asserts'
import {
  bucketOf,
  checkSummary,
  renderCheckGroups,
  type IBucketedResult,
} from './signer-view'
import {
  integrityResults,
  RPC_QUORUM_REPEAT_POINTER,
  signerChecks,
  signerTodos,
  viewDefinitions,
} from './signer-zones'

const ESC = String.fromCharCode(27)
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

const NETWORK = 'arbitrum'

const runWith = (
  registered: readonly string[],
  results: readonly Omit<ICheckResult, 'network'>[]
): IIntegrityAssertRun => {
  const ledger = createCheckLedger({
    expectedNetworks: [NETWORK],
    checks: registered.map((checkId) => {
      const definition = INTEGRITY_CHECK_DEFINITIONS[checkId]
      if (!definition) throw new Error(`no definition for ${checkId}`)
      return definition
    }),
  })
  for (const result of results)
    recordCheck(ledger, { ...result, network: NETWORK })
  return {
    ledger,
    verdict: summariseLedger(ledger),
    registered: [...registered],
    gradedKey: 'graded-key',
  }
}

/** One failing row for `checkId`, rendered the way a signer sees it. */
const renderFailing = (
  checkId: string,
  extra: readonly ICheckDefinition[] = []
): string =>
  renderCheckGroups(
    signerChecks({
      results: [
        {
          checkId,
          network: NETWORK,
          status: 'fail',
          expected: 'the declared value',
          actual: 'something else',
          anchor: 'A-CHAIN',
        },
      ],
      definitions: viewDefinitions(extra),
    })
  )
    .map(stripAnsi)
    .join('\n')

describe('gate naming', () => {
  it('heads a row with the gate letter and its title', () => {
    expect(renderFailing(CHECK_SIGNATURES)).toContain(
      'Gate C \u00b7 Every signature is from a distinct current owner'
    )
  })

  it("uses an extra definition's own letter", () => {
    expect(
      renderFailing('executability', [
        {
          checkId: 'executability',
          section: 'Execution',
          checkClass: 'semantic',
          gate: 'I',
          title: 'Calldata simulation',
        },
      ])
    ).toContain('Gate I \u00b7 Calldata simulation')
  })

  it('heads a failing row with the gate letter and its title too', () => {
    const rendered = renderFailing(CHECK_SAFE_TX_HASH)

    expect(rendered).toContain(
      'Gate B \u00b7 Stored tx hash matches the recomputed one'
    )
  })

  it('gives every definition a unique single-letter gate', () => {
    const definitions = [...viewDefinitions().values()]

    expect(definitions.length).toBeGreaterThan(1)
    for (const definition of definitions)
      expect(definition.gate).toMatch(/^[A-Z]$/u)

    const letters = definitions.map((definition) => definition.gate)
    expect(new Set(letters).size).toBe(letters.length)
  })
})

describe('integrityResults', () => {
  it('reports a run that never happened as unverified, never as a pass', () => {
    const { results } = integrityResults(undefined)

    expect(results).toHaveLength(1)
    expect(
      bucketOf({ result: results[0] as ICheckResult, definition: undefined })
    ).toBe('unchecked')
  })

  it('calls a check that was registered and answered nothing unverified', () => {
    const { results } = integrityResults(runWith([CHECK_SAFE_ADDRESS], []))

    expect(results[0]?.status).toBe('error')
  })

  it('reports an unregistered delay check as not applicable, not as a status', () => {
    const { results, notApplicable } = integrityResults(
      runWith(
        [CHECK_SAFE_ADDRESS],
        [
          {
            checkId: CHECK_SAFE_ADDRESS,
            status: 'pass',
            expected: 'the configured Safe',
            actual: 'the configured Safe',
            anchor: 'A-LOCAL',
          },
        ]
      )
    )

    expect(results.map((result) => result.checkId)).toEqual([
      CHECK_SAFE_ADDRESS,
    ])
    expect(notApplicable.get(CHECK_TIMELOCK_DELAY)).toContain(
      'not a timelock schedule'
    )
  })
})

describe('signerChecks', () => {
  it('groups a not-applicable check under its reason rather than a verdict', () => {
    const rows = signerChecks({
      results: [],
      notApplicable: new Map([
        [CHECK_TIMELOCK_DELAY, 'this proposal is not a timelock schedule'],
      ]),
      definitions: viewDefinitions(),
    })
    const rendered = renderCheckGroups(rows).map(stripAnsi).join('\n')

    expect(rendered).toContain('NOT APPLICABLE')
    expect(rendered.replace(/\s+/gu, ' ')).toContain('not a timelock schedule')
    expect(rendered).not.toContain('PASSED')
  })

  it('never puts a check that answered in the not-applicable bucket too', () => {
    const rows = signerChecks({
      results: [
        {
          checkId: CHECK_TIMELOCK_DELAY,
          network: NETWORK,
          status: 'pass',
          expected: 'nothing to compare',
          actual: 'this proposal schedules nothing',
          anchor: 'A-LOCAL',
        },
      ],
      notApplicable: new Map([
        [CHECK_TIMELOCK_DELAY, 'this proposal is not a timelock schedule'],
      ]),
      definitions: viewDefinitions(),
    })

    expect(rows).toHaveLength(1)
    expect(renderCheckGroups(rows).map(stripAnsi).join('\n')).not.toContain(
      'NOT APPLICABLE'
    )
  })

  it('carries a definition-less result through under its check id', () => {
    const rows = signerChecks({
      results: [
        {
          checkId: 'invented',
          network: NETWORK,
          status: 'fail',
          expected: 'something',
          actual: 'something else',
          anchor: 'A-CHAIN',
        },
      ],
      definitions: viewDefinitions(),
    })

    expect(renderCheckGroups(rows).map(stripAnsi).join('\n')).toContain(
      'invented'
    )
  })
})

describe('signerTodos', () => {
  it('puts the message comparison before the device panel', () => {
    const todos = signerTodos({
      deviceHash: `0x${'ab'.repeat(32)}`,
      storedHash: 'agrees',
      devicePanel: ['screen 1'],
    })

    expect(todos).toHaveLength(2)
    expect(todos[0]?.text).toContain('the proposer sent you')
    expect(todos[1]?.text).toContain('device')
  })

  it('says the hash could not be computed rather than showing none', () => {
    const [todo] = signerTodos({})

    expect(stripAnsi((todo?.lines ?? []).join('\n'))).toContain(
      'could not be computed'
    )
  })

  it('warns when the stored hash disagrees with the computed one', () => {
    const [todo] = signerTodos({
      deviceHash: `0x${'cd'.repeat(32)}`,
      storedHash: 'disagrees',
    })

    expect(stripAnsi((todo?.lines ?? []).join('\n'))).toContain(
      'is not the hash the Safe computes'
    )
  })

  it('omits the device step when no panel could be drawn', () => {
    expect(signerTodos({ deviceHash: `0x${'ef'.repeat(32)}` })).toHaveLength(1)
  })
})

describe('a device note carrying its own line breaks', () => {
  it('indents every line of it, not just the first', () => {
    const [, device] = signerTodos({
      deviceHash: `0x${'ab'.repeat(32)}`,
      devicePanel: ['screen'],
      devicePanelNote: 'first caveat\nsecond caveat',
    })

    expect(device?.lines).toEqual(['screen', 'first caveat', 'second caveat'])
  })
})

describe('the Safe-address check', () => {
  it('is headed by its gate letter and title', () => {
    expect(renderFailing(CHECK_SAFE_ADDRESS)).toContain(
      'Gate A \u00b7 Safe matches networks.json'
    )
  })
})

describe("gate J's paragraph, printed once per network", () => {
  const quorum = (overrides: Partial<ICheckResult> = {}): ICheckResult => ({
    checkId: RPC_QUORUM_CHECK_ID,
    network: NETWORK,
    status: 'needs-ack',
    expected: '2 independent providers agreeing',
    actual: '0 of 0 agreed (provider-identity-unverifiable)',
    anchor: 'A-UNRESOLVED',
    detail: 'give every endpoint a hostname',
    ...overrides,
  })

  const render = (
    rows: readonly Parameters<typeof renderCheckGroups>[0][number][]
  ): string => renderCheckGroups(rows).map(stripAnsi).join('\n')

  it('prints the expected/observed paragraph when nothing was shown before', () => {
    const rows = signerChecks({
      results: [quorum()],
      definitions: viewDefinitions([RPC_QUORUM_CHECK]),
    })
    const rendered = render(rows)

    expect(rendered).toContain('Gate J · Independent RPCs agree')
    expect(rendered).toContain('2 independent providers agreeing')
    expect(rendered).toContain('provider-identity-unverifiable')
    expect(rendered).toContain('give every endpoint a hostname')
    expect(rendered).not.toContain(RPC_QUORUM_REPEAT_POINTER)
  })

  it('points a later proposal at the first when the verdict repeats word for word', () => {
    const rows = signerChecks({
      results: [quorum()],
      rpcQuorumShown: quorum(),
      definitions: viewDefinitions([RPC_QUORUM_CHECK]),
    })
    const rendered = render(rows)

    expect(rendered).toContain('Gate J · Independent RPCs agree')
    expect(rendered).toContain(RPC_QUORUM_REPEAT_POINTER)
    expect(rendered).not.toContain('2 independent providers agreeing')
    expect(rendered).not.toContain('provider-identity-unverifiable')
    expect(rendered).not.toContain('give every endpoint a hostname')
  })

  it('keeps the verdict, the bucket and the count while the paragraph goes', () => {
    const rows = signerChecks({
      results: [quorum()],
      rpcQuorumShown: quorum(),
      definitions: viewDefinitions([RPC_QUORUM_CHECK]),
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.result.status).toBe('needs-ack')
    expect(bucketOf(rows[0] as IBucketedResult)).toBe('ack')
    expect(checkSummary(rows)).toBe('1 to acknowledge')
    expect(render(rows)).toContain('NEEDS YOUR ACKNOWLEDGEMENT')
  })

  it('prints the paragraph again when this proposal read something else', () => {
    const rows = signerChecks({
      results: [quorum({ actual: '1 of 2 agreed (disagreement)' })],
      rpcQuorumShown: quorum(),
      definitions: viewDefinitions([RPC_QUORUM_CHECK]),
    })
    const rendered = render(rows)

    expect(rendered).toContain('1 of 2 agreed (disagreement)')
    expect(rendered).toContain('2 independent providers agreeing')
    expect(rendered).not.toContain(RPC_QUORUM_REPEAT_POINTER)
  })

  it("leaves every other gate's paragraph alone", () => {
    const rows = signerChecks({
      results: [
        {
          checkId: CHECK_SAFE_ADDRESS,
          network: NETWORK,
          status: 'fail',
          expected: 'the declared value',
          actual: 'something else',
          anchor: 'A-CHAIN',
        },
      ],
      rpcQuorumShown: quorum(),
      definitions: viewDefinitions([RPC_QUORUM_CHECK]),
    })
    const rendered = render(rows)

    expect(rendered).toContain('the declared value')
    expect(rendered).toContain('something else')
    expect(rendered).not.toContain(RPC_QUORUM_REPEAT_POINTER)
  })
})
