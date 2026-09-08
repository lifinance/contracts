/**
 * Tests for the Tier-0 executability simulation.
 *
 * The diamond, the facet addresses and the selectors are the real Ethereum
 * mainnet ones (`deployments/mainnet.json` and `mainnet.diamond.json`), and the
 * selector-to-facet map is the one `facets()` reports there, so a refusal
 * exercised here is a refusal exercised against a live diamond's shape rather
 * than against a fixture invented to satisfy it.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  assertProposalWouldExecute,
  evaluateExecutability,
  ExecutabilityFindingEnum,
  FacetCutActionEnum,
  renderExecutability,
  RevertCertaintyEnum,
  toCancelDecisionExecutability,
  type IChainObservations,
  type IExecutabilityInput,
  type IExecutabilityVerdict,
  type IFacetCutInput,
  type TSimulatedPayload,
} from './executability-simulation'

const ZERO = '0x0000000000000000000000000000000000000000'
/** `LiFiDiamond` on Ethereum mainnet. */
const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
/** The account `owner()` returns for that diamond. */
const OWNER = '0x55117ECcC867Db72aEb25f728CCf57C3C3B4faEe'
/** `DiamondLoupeFacet` there, and two selectors it really serves. */
const LOUPE = '0xF5ba8Db6fEA7aF820De35C8D0c294e17DBC1b9D2'
const FACETS_SELECTOR = '0xcdffacc6'
const FACET_ADDRESS_SELECTOR = '0x52ef6b2c'
/** `DiamondCutFacet` there. */
const CUT_FACET = '0xf7993A8df974AD022647E63402d6315137c58ABf'
/** A selector `facetAddress()` reports as served by nobody. */
const UNSERVED = '0xdeadbeef'
/** An address with no code on mainnet. */
const CODELESS = '0x00000000000000000000000000000000C0FFEE01'
const PATH = 'call[0].diamondCut'

const observations = (
  overrides: Partial<IChainObservations> = {}
): IChainObservations => ({
  available: true,
  selectorFacets: new Map([
    [FACETS_SELECTOR, LOUPE.toLowerCase()],
    [FACET_ADDRESS_SELECTOR, LOUPE.toLowerCase()],
    [UNSERVED, ZERO],
  ]),
  hasCode: new Map([
    [LOUPE.toLowerCase(), true],
    [CUT_FACET.toLowerCase(), true],
    [DIAMOND.toLowerCase(), true],
    [CODELESS.toLowerCase(), false],
  ]),
  owners: new Map([[DIAMOND.toLowerCase(), OWNER.toLowerCase()]]),
  ...overrides,
})

const cut = (
  action: number,
  facetAddress: string,
  selectors: readonly string[],
  index = 0
): IFacetCutInput => ({
  action,
  facetAddress,
  selectors,
  path: `${PATH}.cuts[${index}]`,
})

const cutCall = (
  cuts: readonly IFacetCutInput[],
  overrides: Partial<Extract<TSimulatedPayload, { kind: 'diamond-cut' }>> = {}
): TSimulatedPayload => ({
  kind: 'diamond-cut',
  path: PATH,
  diamond: DIAMOND,
  caller: OWNER,
  cuts,
  init: ZERO,
  initCalldata: '0x',
  ...overrides,
})

/** A verdict for one payload whose `eth_call` succeeded, so findings stand alone. */
const evaluate = (
  payload: TSimulatedPayload,
  overrides: Partial<IExecutabilityInput> = {}
): IExecutabilityVerdict =>
  evaluateExecutability({
    network: 'mainnet',
    payloads: [payload],
    observations: observations(),
    staticCalls: {
      attempted: true,
      results: [{ path: payload.path, outcome: 'succeeded', from: OWNER }],
    },
    ...overrides,
  })

/**
 * The same, for a payload whose `eth_call` reverted — which is what a node
 * really returns for every payload the proven checks reject, so a proven case
 * evaluated against a succeeding call would be a state no chain can produce.
 */
const evaluateReverting = (
  payload: TSimulatedPayload,
  revertReason?: string
): IExecutabilityVerdict =>
  evaluateExecutability({
    network: 'mainnet',
    payloads: [payload],
    observations: observations(),
    staticCalls: {
      attempted: true,
      results: [
        { path: payload.path, outcome: 'reverted', from: OWNER, revertReason },
      ],
    },
  })

/**
 * Two payloads in one proposal, each with its own succeeding `eth_call`.
 *
 * A node simulates each call against the state before the proposal runs, so both
 * succeed individually even when the second cannot execute after the first — the
 * composition is what no single `eth_call` observes.
 */
const evaluateBoth = (
  payloads: readonly TSimulatedPayload[]
): IExecutabilityVerdict =>
  evaluateExecutability({
    network: 'mainnet',
    payloads,
    observations: observations(),
    staticCalls: {
      attempted: true,
      results: payloads.map((payload) => ({
        path: payload.path,
        outcome: 'succeeded' as const,
        from: OWNER,
      })),
    },
  })

const codes = (verdict: IExecutabilityVerdict): ExecutabilityFindingEnum[] =>
  verdict.findings.map((finding) => finding.code)

const findingFor = (
  verdict: IExecutabilityVerdict,
  code: ExecutabilityFindingEnum
) => {
  const found = verdict.findings.find((finding) => finding.code === code)
  if (!found) throw new Error(`no ${code} finding in ${codes(verdict).join()}`)
  return found
}

describe('a proposal that executes', () => {
  it('passes a Replace of two selectors the real diamond serves', () => {
    const verdict = evaluate(
      cutCall([
        cut(FacetCutActionEnum.Replace, CUT_FACET, [
          FACETS_SELECTOR,
          FACET_ADDRESS_SELECTOR,
        ]),
      ])
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.error).toBe(false)
    expect(verdict.findings).toEqual([])
    expect(verdict.reason).toBe('')
    expect(toCancelDecisionExecutability(verdict)).toBe('ok')
    expect(() => assertProposalWouldExecute(verdict)).not.toThrow()
  })

  it('says so in one line that does not claim the proposal is correct', () => {
    const lines = renderExecutability(
      evaluate(
        cutCall([cut(FacetCutActionEnum.Replace, CUT_FACET, [FACETS_SELECTOR])])
      )
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Nothing in this proposal reverts')
    expect(lines[0]).toContain('not a statement that the proposal is correct')
  })

  it('passes an Add of a selector nobody serves', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])])
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.findings).toEqual([])
  })

  it('passes a Remove of a selector the diamond really serves', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Remove, ZERO, [FACETS_SELECTOR])])
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.findings).toEqual([])
  })

  it('passes a cut whose _init is the diamond itself, which needs no code read', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])], {
        init: DIAMOND,
        initCalldata: '0xdeadbeef',
      })
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.error).toBe(false)
  })
})

describe('proven from the calldata alone', () => {
  it('refuses a Remove cut naming a facet address — the case EXSC-699 scoped to S11', () => {
    const verdict = evaluateReverting(
      cutCall([cut(FacetCutActionEnum.Remove, LOUPE, [FACETS_SELECTOR])]),
      'FacetAddressIsNotZero()'
    )

    const finding = findingFor(
      verdict,
      ExecutabilityFindingEnum.FacetAddressIsNotZero
    )
    expect(finding.certainty).toBe(RevertCertaintyEnum.Proven)
    expect(finding.blocking).toBe(true)
    expect(finding.detail).toContain(LOUPE)
    expect(verdict.refuses).toBe(true)
    expect(verdict.error).toBe(false)
    expect(toCancelDecisionExecutability(verdict)).toBe('would-revert')
  })

  it('refuses an Add or Replace cut with the zero facet address', () => {
    for (const action of [FacetCutActionEnum.Add, FacetCutActionEnum.Replace]) {
      const verdict = evaluateReverting(
        cutCall([cut(action, ZERO, [FACETS_SELECTOR])])
      )

      expect(
        findingFor(verdict, ExecutabilityFindingEnum.FacetAddressIsZero)
          .certainty
      ).toBe(RevertCertaintyEnum.Proven)
      expect(verdict.refuses).toBe(true)
    }
  })

  it('refuses a cut carrying no selectors, whatever its action', () => {
    for (const action of [
      FacetCutActionEnum.Add,
      FacetCutActionEnum.Replace,
      FacetCutActionEnum.Remove,
    ]) {
      const verdict = evaluateReverting(
        cutCall([
          cut(action, action === FacetCutActionEnum.Remove ? ZERO : LOUPE, []),
        ])
      )

      expect(
        findingFor(verdict, ExecutabilityFindingEnum.NoSelectorsInFace)
          .certainty
      ).toBe(RevertCertaintyEnum.Proven)
      expect(verdict.refuses).toBe(true)
    }
  })

  it('refuses a cut action that does not exist, and grades no selector against it', () => {
    const verdict = evaluateReverting(
      cutCall([cut(7, LOUPE, [FACETS_SELECTOR])])
    )

    expect(
      findingFor(verdict, ExecutabilityFindingEnum.IncorrectFacetCutAction)
        .certainty
    ).toBe(RevertCertaintyEnum.Proven)
    expect(codes(verdict)).toEqual([
      ExecutabilityFindingEnum.IncorrectFacetCutAction,
      ExecutabilityFindingEnum.StaticCallReverted,
    ])
  })

  it('refuses _init zero with calldata, and _init set with no calldata', () => {
    const withCalldata = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])], {
        init: ZERO,
        initCalldata: '0xdeadbeef',
      })
    )
    expect(
      findingFor(
        withCalldata,
        ExecutabilityFindingEnum.InitZeroButCalldataNotEmpty
      ).certainty
    ).toBe(RevertCertaintyEnum.Proven)

    const withoutCalldata = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])], {
        init: LOUPE,
        initCalldata: '0x',
      })
    )
    expect(
      findingFor(
        withoutCalldata,
        ExecutabilityFindingEnum.CalldataEmptyButInitNotZero
      ).certainty
    ).toBe(RevertCertaintyEnum.Proven)
  })

  it('treats an empty string as absent calldata, exactly as 0x is', () => {
    const verdict = evaluateReverting(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])], {
        init: LOUPE,
        initCalldata: '',
      })
    )

    expect(
      findingFor(verdict, ExecutabilityFindingEnum.CalldataEmptyButInitNotZero)
    ).toBeDefined()
  })

  it('proves a conflict the batch creates within itself, not merely predicts it', () => {
    const verdict = evaluateReverting(
      cutCall([
        cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED], 0),
        cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED], 1),
      ])
    )

    const finding = findingFor(
      verdict,
      ExecutabilityFindingEnum.FunctionAlreadyExists
    )
    expect(finding.certainty).toBe(RevertCertaintyEnum.Proven)
    expect(finding.detail).toContain('by an earlier cut in this same call')
    expect(finding.path).toBe(`${PATH}.cuts[1].selectors[0]`)
  })

  it('proves a Remove of a selector an earlier cut in the batch already removed', () => {
    const verdict = evaluateReverting(
      cutCall([
        cut(FacetCutActionEnum.Remove, ZERO, [FACETS_SELECTOR], 0),
        cut(FacetCutActionEnum.Remove, ZERO, [FACETS_SELECTOR], 1),
      ])
    )

    const finding = findingFor(
      verdict,
      ExecutabilityFindingEnum.FunctionDoesNotExist
    )
    expect(finding.certainty).toBe(RevertCertaintyEnum.Proven)
    // T2's warn-only carve-out is about state that can move, so it does not
    // reach a removal the batch itself makes impossible.
    expect(finding.blocking).toBe(true)
    expect(verdict.refuses).toBe(true)
  })

  it('does not carry an earlier cut Add over as a chain read', () => {
    const verdict = evaluate(
      cutCall([
        cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED], 0),
        cut(FacetCutActionEnum.Remove, ZERO, [UNSERVED], 1),
      ])
    )

    expect(verdict.findings).toEqual([])
    expect(verdict.refuses).toBe(false)
  })
})

describe('predicted from state read now', () => {
  it('refuses an Add of a selector the real diamond already serves', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [FACETS_SELECTOR])])
    )

    const finding = findingFor(
      verdict,
      ExecutabilityFindingEnum.FunctionAlreadyExists
    )
    expect(finding.certainty).toBe(RevertCertaintyEnum.Predicted)
    expect(finding.blocking).toBe(true)
    expect(finding.detail).toContain('on chain')
    expect(finding.detail).toContain(LOUPE.toLowerCase())
  })

  it('refuses a Replace of a selector nobody serves', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Replace, CUT_FACET, [UNSERVED])])
    )

    expect(
      findingFor(verdict, ExecutabilityFindingEnum.FunctionDoesNotExist)
        .blocking
    ).toBe(true)
  })

  it('refuses a Replace pointing a selector at the facet that already serves it', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Replace, LOUPE, [FACETS_SELECTOR])])
    )

    expect(
      findingFor(verdict, ExecutabilityFindingEnum.FunctionAlreadyExists).detail
    ).toContain('already serves it')
  })

  it('refuses a Replace or Remove of a selector defined on the diamond itself', () => {
    const immutable = observations({
      selectorFacets: new Map([[FACETS_SELECTOR, DIAMOND.toLowerCase()]]),
    })

    for (const [action, facet] of [
      [FacetCutActionEnum.Replace, CUT_FACET],
      [FacetCutActionEnum.Remove, ZERO],
    ] as const) {
      const verdict = evaluate(
        cutCall([cut(action, facet, [FACETS_SELECTOR])]),
        { observations: immutable }
      )

      expect(
        findingFor(verdict, ExecutabilityFindingEnum.FunctionIsImmutable)
          .certainty
      ).toBe(RevertCertaintyEnum.Predicted)
    }
  })

  it('refuses an Add or Replace naming an address with no code, once per address', () => {
    const verdict = evaluate(
      cutCall([
        cut(FacetCutActionEnum.Add, CODELESS, [UNSERVED], 0),
        cut(FacetCutActionEnum.Add, CODELESS, ['0xfeedface'], 1),
      ]),
      {
        observations: observations({
          selectorFacets: new Map([
            [UNSERVED, ZERO],
            ['0xfeedface', ZERO],
          ]),
        }),
      }
    )

    expect(
      verdict.findings.filter(
        (finding) =>
          finding.code === ExecutabilityFindingEnum.FacetContainsNoCode
      )
    ).toHaveLength(1)
    expect(verdict.refuses).toBe(true)
  })

  it('refuses an _init target with no code', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])], {
        init: CODELESS,
        initCalldata: '0xdeadbeef',
      })
    )

    const finding = findingFor(
      verdict,
      ExecutabilityFindingEnum.FacetContainsNoCode
    )
    expect(finding.path).toBe(`${PATH}._init`)
    expect(finding.blocking).toBe(true)
  })

  it('refuses a cut sent by an account the diamond does not report as owner', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Replace, CUT_FACET, [FACETS_SELECTOR])], {
        caller: CODELESS,
      })
    )

    const finding = findingFor(
      verdict,
      ExecutabilityFindingEnum.OnlyContractOwner
    )
    expect(finding.blocking).toBe(true)
    expect(finding.detail).toContain(OWNER.toLowerCase())
  })

  it('does not call a checksum difference an owner mismatch', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Replace, CUT_FACET, [FACETS_SELECTOR])], {
        caller: OWNER.toLowerCase(),
      })
    )

    expect(codes(verdict)).toEqual([])
  })

  it('reports the eth_call revert reason the node returned', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Replace, CUT_FACET, [FACETS_SELECTOR])]),
      {
        staticCalls: {
          attempted: true,
          results: [
            {
              path: PATH,
              outcome: 'reverted',
              from: OWNER,
              revertReason: 'FunctionDoesNotExist()',
            },
          ],
        },
      }
    )

    const finding = findingFor(
      verdict,
      ExecutabilityFindingEnum.StaticCallReverted
    )
    expect(finding.detail).toContain('FunctionDoesNotExist()')
    expect(finding.blocking).toBe(true)
    expect(verdict.error).toBe(false)
  })

  it('reports a revert the node gave no reason for', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Replace, CUT_FACET, [FACETS_SELECTOR])]),
      {
        staticCalls: {
          attempted: true,
          results: [{ path: PATH, outcome: 'reverted', from: OWNER }],
        },
      }
    )

    expect(
      findingFor(verdict, ExecutabilityFindingEnum.StaticCallReverted).detail
    ).toContain('without a reason')
  })
})

describe('T2 keeps a removal warn-only where the answer could be wrong', () => {
  it('warns rather than blocks on a Remove of a selector chain says nobody serves', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Remove, ZERO, [UNSERVED])])
    )

    const finding = findingFor(
      verdict,
      ExecutabilityFindingEnum.FunctionDoesNotExist
    )
    expect(finding.certainty).toBe(RevertCertaintyEnum.Predicted)
    expect(finding.blocking).toBe(false)
    expect(verdict.refuses).toBe(false)
    expect(verdict.warnings).toEqual([finding.detail])
    expect(renderExecutability(verdict)[0]).toContain('removes 0xdeadbeef')
  })

  it('blocks the Add half of a mixed batch while the Remove half only warns', () => {
    const verdict = evaluate(
      cutCall([
        cut(FacetCutActionEnum.Remove, ZERO, [UNSERVED], 0),
        cut(FacetCutActionEnum.Add, CUT_FACET, [FACETS_SELECTOR], 1),
      ])
    )

    const removal = verdict.findings.find(
      (finding) => finding.path === `${PATH}.cuts[0].selectors[0]`
    )
    const addition = verdict.findings.find(
      (finding) => finding.path === `${PATH}.cuts[1].selectors[0]`
    )
    expect(removal?.blocking).toBe(false)
    expect(addition?.blocking).toBe(true)
    expect(verdict.refuses).toBe(true)
  })

  it('still blocks a proven revert on a Remove cut', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Remove, LOUPE, [FACETS_SELECTOR])]),
      {
        staticCalls: {
          attempted: true,
          results: [{ path: PATH, outcome: 'reverted', from: OWNER }],
        },
      }
    )

    expect(verdict.refuses).toBe(true)
    expect(verdict.error).toBe(false)
    expect(verdict.warnings).toEqual([])
  })
})

describe('the simulation could not run (T3)', () => {
  it('errors and blocks when chain state was unreadable, and names why', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Replace, CUT_FACET, [FACETS_SELECTOR])]),
      {
        observations: {
          available: false,
          unavailableReason: 'every endpoint refused the connection',
          selectorFacets: new Map(),
          hasCode: new Map(),
          owners: new Map(),
        },
      }
    )

    expect(verdict.error).toBe(true)
    expect(verdict.errors[0]).toContain('every endpoint refused the connection')
    expect(toCancelDecisionExecutability(verdict)).toBe('error')
    expect(() => assertProposalWouldExecute(verdict)).toThrow(
      /will not be signed/
    )
  })

  it('errors when chain state was unreadable and no reason was given', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Replace, CUT_FACET, [FACETS_SELECTOR])]),
      {
        observations: {
          available: false,
          selectorFacets: new Map(),
          hasCode: new Map(),
          owners: new Map(),
        },
      }
    )

    expect(verdict.errors[0]).toContain('could not be read,')
  })

  it('errors when no eth_call was attempted at all', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Replace, CUT_FACET, [FACETS_SELECTOR])]),
      { staticCalls: { attempted: false, results: [] } }
    )

    expect(verdict.error).toBe(true)
    expect(verdict.errors.join(' ')).toContain('No payload in this proposal')
    expect(verdict.refuses).toBe(false)
    expect(() => assertProposalWouldExecute(verdict)).toThrow()
  })

  it('errors when one payload of several was left unsimulated', () => {
    const other: TSimulatedPayload = {
      kind: 'opaque',
      path: 'call[1]',
      description: 'approve(address,uint256)',
      target: LOUPE,
      calldataLength: 68,
    }
    const verdict = evaluateExecutability({
      network: 'mainnet',
      payloads: [
        cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])]),
        other,
      ],
      observations: observations(),
      staticCalls: {
        attempted: true,
        results: [{ path: PATH, outcome: 'succeeded', from: OWNER }],
      },
    })

    expect(verdict.errors.join(' ')).toContain('call[1] has no eth_call result')
    expect(verdict.error).toBe(true)
  })

  it('errors when an eth_call could not be sent, rather than reading it as a pass', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])]),
      {
        staticCalls: {
          attempted: true,
          results: [
            {
              path: PATH,
              outcome: 'errored',
              from: OWNER,
              errorReason: 'the endpoint returned HTTP 429',
            },
          ],
        },
      }
    )

    expect(verdict.error).toBe(true)
    expect(verdict.errors.join(' ')).toContain('HTTP 429')
    expect(verdict.refuses).toBe(false)
    expect(toCancelDecisionExecutability(verdict)).toBe('error')
  })

  it('errors when an eth_call could not be sent and gave no reason', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])]),
      {
        staticCalls: {
          attempted: true,
          results: [{ path: PATH, outcome: 'errored', from: OWNER }],
        },
      }
    )

    expect(verdict.errors.join(' ')).toContain('could not be made,')
  })

  it('errors on a selector nobody looked up, instead of grading it', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, ['0x11111111'])]),
      { observations: observations({ selectorFacets: new Map() }) }
    )

    expect(verdict.error).toBe(true)
    expect(verdict.errors.join(' ')).toContain('never looked up')
    expect(verdict.findings).toEqual([])
  })

  it('errors on a facet address nobody checked for code', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])]),
      { observations: observations({ hasCode: new Map() }) }
    )

    expect(verdict.errors.join(' ')).toContain('never checked for code')
  })

  it('errors on an _init address nobody checked for code', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])], {
        init: LOUPE,
        initCalldata: '0xdeadbeef',
      }),
      {
        observations: observations({
          hasCode: new Map([[CUT_FACET.toLowerCase(), true]]),
        }),
      }
    )

    expect(verdict.errors.join(' ')).toContain(
      `${PATH}._init (${LOUPE}) was never checked for code`
    )
  })

  it('errors on a diamond whose owner nobody read', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])]),
      { observations: observations({ owners: new Map() }) }
    )

    expect(verdict.errors.join(' ')).toContain('was never read')
  })

  it('errors on a call the decoder could not read all the way through', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])]),
      { undecodable: ['call[2].scheduleBatch'] }
    )

    expect(verdict.errors[0]).toContain('call[2].scheduleBatch')
    expect(verdict.errors[0]).toContain('may contain others')
  })

  it('errors when eth_call and the calldata disagree, preferring neither', () => {
    // Synthetic by necessity: a real node cannot report success for a payload
    // LibDiamond rejects, which is exactly why the disagreement is worth an
    // error rather than a silent choice between the two.
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Remove, LOUPE, [FACETS_SELECTOR])])
    )

    expect(verdict.error).toBe(true)
    expect(verdict.errors.join(' ')).toContain('prove it cannot execute')
    expect(verdict.errors.join(' ')).toContain('FacetAddressIsNotZero')
    expect(verdict.refuses).toBe(true)
    expect(toCancelDecisionExecutability(verdict)).toBe('error')
  })

  it('renders every error as a line an operator cannot mistake for a pass', () => {
    const lines = renderExecutability(
      evaluate(
        cutCall([
          cut(FacetCutActionEnum.Replace, CUT_FACET, [FACETS_SELECTOR]),
        ]),
        { staticCalls: { attempted: false, results: [] } }
      )
    )

    expect(lines.some((line) => line.includes('CANNOT SIMULATE'))).toBe(true)
    expect(
      lines.some((line) => line.includes('Nothing in this proposal'))
    ).toBe(false)
  })
})

describe('payloads Tier-0 has no revert model for', () => {
  const opaque = (
    overrides: Partial<Extract<TSimulatedPayload, { kind: 'opaque' }>> = {}
  ): TSimulatedPayload => ({
    kind: 'opaque',
    path: PATH,
    description: 'approve(address,uint256)',
    target: LOUPE,
    calldataLength: 68,
    ...overrides,
  })

  it('names them rather than counting them as simulated', () => {
    const verdict = evaluate(opaque())

    expect(verdict.notSimulated).toHaveLength(1)
    expect(verdict.notSimulated[0]).toContain('does not model')
    expect(verdict.refuses).toBe(false)
    expect(renderExecutability(verdict).at(-1)).toContain('1 payload(s)')
  })

  it('refuses a function call whose target holds no code', () => {
    const verdict = evaluate(opaque({ target: CODELESS }))

    const finding = findingFor(
      verdict,
      ExecutabilityFindingEnum.TargetHasNoCode
    )
    expect(finding.blocking).toBe(true)
    expect(finding.detail).toContain('silently do nothing')
  })

  it('passes a plain value transfer to an address with no code', () => {
    const verdict = evaluate(
      opaque({
        target: CODELESS,
        calldataLength: 0,
        description: 'ETH transfer',
      })
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.findings).toEqual([])
  })

  it('errors when nobody checked the target for code', () => {
    const verdict = evaluate(opaque({ target: CODELESS }), {
      observations: observations({ hasCode: new Map() }),
    })

    expect(verdict.errors.join(' ')).toContain('never checked for code')
  })
})

describe('nonce', () => {
  const payload = cutCall([
    cut(FacetCutActionEnum.Replace, CUT_FACET, [FACETS_SELECTOR]),
  ])

  it('refuses a nonce the Safe has already passed, and calls it proven', () => {
    const verdict = evaluate(payload, {
      nonce: { proposalNonce: 1, safeNonce: 125 },
    })

    const finding = findingFor(
      verdict,
      ExecutabilityFindingEnum.NonceAlreadyUsed
    )
    expect(finding.certainty).toBe(RevertCertaintyEnum.Proven)
    expect(finding.blocking).toBe(true)
  })

  it('warns on two pending proposals at the same nonce', () => {
    const verdict = evaluate(payload, {
      nonce: { proposalNonce: 126, safeNonce: 125, pendingNonces: [126] },
    })

    const finding = findingFor(verdict, ExecutabilityFindingEnum.NonceCollision)
    expect(finding.blocking).toBe(false)
    expect(verdict.refuses).toBe(false)
  })

  it('warns on a gap nothing pending fills, naming the gap', () => {
    const verdict = evaluate(payload, {
      nonce: { proposalNonce: 128, safeNonce: 125, pendingNonces: [126] },
    })

    const finding = findingFor(verdict, ExecutabilityFindingEnum.NonceGap)
    expect(finding.detail).toContain('127')
    expect(finding.detail).not.toContain('126,')
    expect(finding.blocking).toBe(false)
  })

  it('says nothing when the pending queue fills every nonce up to this one', () => {
    const verdict = evaluate(payload, {
      nonce: { proposalNonce: 127, safeNonce: 125, pendingNonces: [125, 126] },
    })

    expect(codes(verdict)).toEqual([])
  })

  it('says nothing about a gap the caller never listed the queue for', () => {
    const verdict = evaluate(payload, {
      nonce: { proposalNonce: 200, safeNonce: 125 },
    })

    expect(codes(verdict)).toEqual([])
  })

  it('says nothing when the Safe nonce was not read', () => {
    const verdict = evaluate(payload, { nonce: { proposalNonce: 1 } })

    expect(codes(verdict)).toEqual([])
  })
})

describe('executor funding', () => {
  const payload = cutCall([
    cut(FacetCutActionEnum.Replace, CUT_FACET, [FACETS_SELECTOR]),
  ])

  it('warns, and does not block, when the executor cannot pay', () => {
    const verdict = evaluate(payload, {
      funding: {
        executor: OWNER,
        balanceWei: 1n,
        estimatedCostWei: 2_000_000_000_000_000n,
      },
    })

    const finding = findingFor(
      verdict,
      ExecutabilityFindingEnum.ExecutorUnderfunded
    )
    expect(finding.blocking).toBe(false)
    expect(verdict.refuses).toBe(false)
    expect(finding.detail).toContain('topping up')
  })

  it('says nothing when the balance covers the estimate', () => {
    const verdict = evaluate(payload, {
      funding: {
        executor: OWNER,
        balanceWei: 3_000_000_000_000_000n,
        estimatedCostWei: 2_000_000_000_000_000n,
      },
    })

    expect(codes(verdict)).toEqual([])
  })

  it('says nothing when either side of the comparison was not read', () => {
    for (const funding of [
      { executor: OWNER, balanceWei: 1n },
      { executor: OWNER, estimatedCostWei: 1n },
    ])
      expect(codes(evaluate(payload, { funding }))).toEqual([])
  })
})

describe('the reason line', () => {
  it('counts blocking findings and how many of them are proven', () => {
    const verdict = evaluate(
      cutCall([
        cut(FacetCutActionEnum.Remove, LOUPE, [FACETS_SELECTOR], 0),
        cut(FacetCutActionEnum.Add, CUT_FACET, [FACET_ADDRESS_SELECTOR], 1),
      ]),
      {
        staticCalls: {
          attempted: true,
          results: [
            {
              path: PATH,
              outcome: 'reverted',
              from: OWNER,
              revertReason: 'FacetAddressIsNotZero()',
            },
          ],
        },
      }
    )

    expect(verdict.reason).toContain('3 blocking finding(s), 1 of them proven')
    expect(() => assertProposalWouldExecute(verdict)).toThrow(
      /3 blocking finding/
    )
  })

  it('is empty on a verdict with nothing to say', () => {
    expect(
      evaluate(cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])]))
        .reason
    ).toBe('')
  })

  it('carries the errors when the simulation could not decide', () => {
    const verdict = evaluate(
      cutCall([cut(FacetCutActionEnum.Add, CUT_FACET, [UNSERVED])]),
      { staticCalls: { attempted: false, results: [] } }
    )

    expect(verdict.reason).toBe(verdict.errors.join(' '))
  })
})

describe('the cancel-decision projection', () => {
  it('prefers error over would-revert, so a failed check cannot drive a block', () => {
    const verdict: IExecutabilityVerdict = {
      refuses: true,
      error: true,
      findings: [],
      errors: ['the endpoint refused'],
      warnings: [],
      notSimulated: [],
      reason: 'x',
    }

    expect(toCancelDecisionExecutability(verdict)).toBe('error')
  })
})

describe('a conflict spanning two calls in one proposal', () => {
  it('refuses two calls that each add the same selector to the same diamond', () => {
    // Each call is clean against the diamond as it stands, and the second
    // cannot execute once the first has run. Nothing simulates the pair, so
    // before the accumulator spanned the proposal this printed the green line.
    const first = cutCall([cut(0, LOUPE, [UNSERVED])], {
      path: 'call[0].diamondCut',
    })
    const second = cutCall([cut(0, LOUPE, [UNSERVED])], {
      path: 'call[1].diamondCut',
    })

    const verdict = evaluateBoth([first, second])

    expect(verdict.refuses).toBe(true)
    expect(codes(verdict)).toContain(
      ExecutabilityFindingEnum.FunctionAlreadyExists
    )
    // Proven, not predicted: the proposal creates the conflict itself, so no
    // reachable state makes it execute.
    expect(
      verdict.findings.some(
        (finding) =>
          finding.code === ExecutabilityFindingEnum.FunctionAlreadyExists &&
          finding.certainty === RevertCertaintyEnum.Proven
      )
    ).toBe(true)
  })

  it('leaves the same selector on two different diamonds alone', () => {
    // Paired presence: the accumulator is keyed by diamond, because a selector
    // moved on one diamond says nothing about another. Without the key this
    // would be a false red on a perfectly ordinary fleet rollout.
    const first = cutCall([cut(0, LOUPE, [UNSERVED])], {
      path: 'call[0].diamondCut',
    })
    const second = cutCall([cut(0, LOUPE, [UNSERVED])], {
      path: 'call[1].diamondCut',
      diamond: '0x00000000000000000000000000000000D1A11111',
    })

    const verdict = evaluateBoth([first, second])

    // Asserted on the conflict finding, not on `error`: the second diamond has
    // no observations here, so unread facts legitimately raise an error — which
    // is the module working, and would mask what this test is about.
    expect(codes(verdict)).not.toContain(
      ExecutabilityFindingEnum.FunctionAlreadyExists
    )
  })

  it('accepts a remove in one call and an add of the same selector in the next', () => {
    // The sequential walk has to run forward across calls too, or this ordinary
    // replace-by-two-steps becomes a false red.
    const first = cutCall([cut(2, ZERO, [FACETS_SELECTOR])], {
      path: 'call[0].diamondCut',
    })
    const second = cutCall([cut(0, CUT_FACET, [FACETS_SELECTOR])], {
      path: 'call[1].diamondCut',
    })

    const verdict = evaluateBoth([first, second])

    expect(codes(verdict)).not.toContain(
      ExecutabilityFindingEnum.FunctionAlreadyExists
    )
  })
})

describe('the set of cut actions the walk recognises', () => {
  it('is exactly Add, Replace and Remove', () => {
    // Pinned as a set, not at one sample value: 3 is the action an off-by-one
    // enum change produces, and a guard asserted at a single value cannot tell
    // the set apart from a wider one.
    for (const action of [3, 4, 255, -1]) {
      const verdict = evaluateReverting(
        cutCall([cut(action, LOUPE, [FACETS_SELECTOR])])
      )

      expect(codes(verdict), String(action)).toContain(
        ExecutabilityFindingEnum.IncorrectFacetCutAction
      )
    }

    // Paired presence: the three real actions are not reported as unknown.
    for (const action of [0, 1, 2]) {
      const verdict = evaluateReverting(
        cutCall([cut(action, LOUPE, [FACETS_SELECTOR])])
      )

      expect(codes(verdict), String(action)).not.toContain(
        ExecutabilityFindingEnum.IncorrectFacetCutAction
      )
    }
  })
})
