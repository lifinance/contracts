// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { summariseRpcError } from './executability-collector'
import {
  ExecutabilityFindingEnum,
  RevertCertaintyEnum,
  type IExecutabilityCall,
  type IExecutabilityFinding,
  type IExecutabilityVerdict,
} from './executability-simulation'
import {
  CHECK_BLOCK_INDENT,
  condenseNodeMessage,
  executabilityNotes,
  executabilityPanel,
  PANEL_WIDTH,
} from './executability-view'
import { VIEW_WIDTH } from './signer-view'

const ESC = String.fromCharCode(27)
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

const finding = (
  overrides: Partial<IExecutabilityFinding> = {}
): IExecutabilityFinding => ({
  code: ExecutabilityFindingEnum.FunctionAlreadyExists,
  certainty: RevertCertaintyEnum.Proven,
  path: 'call[0].diamondCut[0].cuts[0].selectors[0]',
  detail: 'the cut is a no-op LibDiamond rejects',
  blocking: true,
  ...overrides,
})

const call = (
  overrides: Partial<IExecutabilityCall> = {}
): IExecutabilityCall =>
  ({
    path: 'call[0]',
    description: 'diamondCut',
    target: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    caller: '0x5604A94A3438C3074EFFF803fab14B7244fe4E29',
    modelled: true,
    simulation: 'succeeded',
    findings: [],
    outcome: 'would-execute',
    ...overrides,
  } as IExecutabilityCall)

const verdict = (
  overrides: Partial<IExecutabilityVerdict> = {}
): IExecutabilityVerdict =>
  ({
    refuses: false,
    error: false,
    findings: [],
    errors: [],
    warnings: [],
    notSimulated: [],
    calls: [call()],
    reason: '',
    ...overrides,
  } as IExecutabilityVerdict)

/** The shape viem returns, which is what put a calldata dump on the screen. */
const VIEM_REVERT = [
  'Execution reverted with reason: TimelockController: insufficient delay.',
  '',
  'Raw Call Arguments:',
  '  from:  0x743b11478D69C18693F41f25051a10DD4D1a6F39',
  '  to:    0x5604A94A3438C3074EFFF803fab14B7244fe4E29',
  `  data:  0x8f2a0bb${'0'.repeat(600)}1841`,
  '',
  'Details: execution reverted: TimelockController: insufficient delay',
  'Version: viem@2.55.19',
].join('\n')

describe('condenseNodeMessage', () => {
  it('keeps the reason and drops the raw-argument echo and the version', () => {
    const condensed = condenseNodeMessage(VIEM_REVERT)

    expect(condensed).toContain('TimelockController: insufficient delay')
    expect(condensed).not.toContain('Raw Call Arguments')
    expect(condensed).not.toContain('viem@')
    expect(condensed).not.toContain('0'.repeat(60))
  })

  it('elides the middle of a long hex word rather than dropping the line', () => {
    const condensed = condenseNodeMessage(`reverted on 0x${'ab'.repeat(300)}`)

    expect(condensed).toContain('reverted on 0xababab')
    expect(condensed).toContain('…')
    expect(condensed.length).toBeLessThan(120)
  })

  it('leaves an ordinary one-line message alone', () => {
    expect(condenseNodeMessage('execution reverted')).toBe('execution reverted')
  })

  it('keeps a reason that arrives with no trailing sections', () => {
    expect(
      condenseNodeMessage('Execution reverted for an unknown reason.')
    ).toBe('Execution reverted for an unknown reason.')
  })
})

describe('the panel headline', () => {
  it('reads SUCCESSFUL in green when every call would execute', () => {
    const [headline] = executabilityPanel(verdict())

    expect(headline).toContain(`${ESC}[32m`)
    expect(stripAnsi(headline ?? '')).toContain('Simulation: SUCCESSFUL')
    expect(stripAnsi(headline ?? '')).toContain('1 of 1 call would execute')
  })

  it('reads FAILED in red, counting only the calls that would revert', () => {
    const [headline] = executabilityPanel(
      verdict({
        refuses: true,
        calls: [
          call({ outcome: 'would-revert', simulation: 'reverted' }),
          call({ path: 'call[1]', outcome: 'would-execute' }),
        ],
      })
    )

    expect(headline).toContain(`${ESC}[31m`)
    expect(stripAnsi(headline ?? '')).toContain('Simulation: FAILED')
    expect(stripAnsi(headline ?? '')).toContain('1 of 2 calls would revert')
  })

  it('reads INCONCLUSIVE in yellow when the run could not decide', () => {
    const [headline] = executabilityPanel(
      verdict({
        error: true,
        errors: ['the RPC could not be reached'],
        calls: [call({ outcome: 'unknown', simulation: 'errored' })],
      })
    )

    expect(headline).toContain(`${ESC}[33m`)
    expect(stripAnsi(headline ?? '')).toContain('Simulation: INCONCLUSIVE')
  })

  it('says so rather than claiming success when there was nothing to simulate', () => {
    const plain = executabilityPanel(verdict({ calls: [] })).map(stripAnsi)

    expect(plain.join('\n')).toContain('no call was simulated')
    expect(plain.join('\n')).not.toContain('SUCCESSFUL')
  })
})

describe('one section per call', () => {
  it('heads each call with its path, function and target', () => {
    const plain = executabilityPanel(
      verdict({
        calls: [
          call(),
          call({
            path: 'call[1]',
            description: 'scheduleBatch',
            target: '0x5604A94A3438C3074EFFF803fab14B7244fe4E29',
          }),
        ],
      })
    ).map(stripAnsi)

    expect(plain.some((line) => /call\[0\].+diamondCut/u.test(line))).toBe(true)
    expect(plain.some((line) => /call\[1\].+scheduleBatch/u.test(line))).toBe(
      true
    )
  })

  it('files each finding under the call it is about, not in one list', () => {
    const plain = executabilityPanel(
      verdict({
        refuses: true,
        calls: [
          call({
            outcome: 'would-revert',
            findings: [finding({ detail: 'first call is a no-op' })],
          }),
          call({
            path: 'call[1]',
            outcome: 'would-revert',
            findings: [
              finding({
                path: 'call[1].cuts[0]',
                detail: 'second call has no selectors',
              }),
            ],
          }),
        ],
      })
    ).map(stripAnsi)

    const first = plain.findIndex((line) => line.includes('first call'))
    const second = plain.findIndex((line) => line.includes('second call'))
    const between = plain.findIndex(
      (line, index) => index > first && line.includes('call[1]')
    )

    expect(first).toBeGreaterThan(-1)
    expect(between).toBeGreaterThan(first)
    expect(second).toBeGreaterThan(between)
  })

  it('prints the eth_call outcome for each call, condensed', () => {
    const plain = executabilityPanel(
      verdict({
        refuses: true,
        calls: [
          call({
            outcome: 'would-revert',
            simulation: 'reverted',
            simulationDetail: VIEM_REVERT,
          }),
        ],
      })
    ).map(stripAnsi)

    const joined = plain.join(' ')
    expect(joined).toContain('eth_call')
    expect(joined).toContain('TimelockController: insufficient delay')
    expect(joined).not.toContain('Raw Call Arguments')
  })

  it('does not print the reverting eth_call twice', () => {
    const plain = executabilityPanel(
      verdict({
        refuses: true,
        calls: [
          call({
            outcome: 'would-revert',
            simulation: 'reverted',
            simulationDetail: 'boom',
            findings: [
              finding({
                code: ExecutabilityFindingEnum.StaticCallReverted,
                detail: 'eth_call of call[0] from 0xabc reverted with boom',
              }),
            ],
          }),
        ],
      })
    ).map(stripAnsi)

    expect(plain.filter((line) => line.includes('boom'))).toHaveLength(1)
  })

  it('marks a call Tier-0 has no revert model for', () => {
    const plain = executabilityPanel(
      verdict({
        calls: [call({ modelled: false, description: 'transfer' })],
      })
    ).map(stripAnsi)

    expect(plain.join(' ')).toContain('no revert model')
  })

  it('names the sender, because an owner-gated call turns on it', () => {
    const plain = executabilityPanel(verdict()).map(stripAnsi)

    expect(plain.join(' ')).toContain('0x5604A9')
  })
})

describe('what belongs to no single call', () => {
  it('prints a nonce or funding finding under its own heading', () => {
    const plain = executabilityPanel(
      verdict({
        findings: [
          finding({
            code: ExecutabilityFindingEnum.NonceCollision,
            path: 'nonce',
            detail: 'another pending proposal sits at nonce 31',
          }),
        ],
      })
    ).map(stripAnsi)

    expect(plain.join(' ')).toContain('another pending proposal sits at nonce')
    expect(plain.join(' ')).toContain('this proposal as a whole')
  })

  it('prints why the run could not decide', () => {
    const plain = executabilityPanel(
      verdict({
        error: true,
        errors: ['chain state for arbitrum could not be read'],
      })
    ).map(stripAnsi)

    expect(plain.join(' ')).toContain('chain state for arbitrum could not be')
  })

  it('keeps the path and the address a run-level error names whole', () => {
    const plain = executabilityPanel(
      verdict({
        error: true,
        errors: [
          'call[0].diamondCut[0].cuts[0].selectors[1] (0x1794958f) was never looked up on 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE, so whether a Replace of it succeeds is unknown.',
        ],
      })
    ).map(stripAnsi)

    const errorLines = plain
      .slice(plain.findIndex((line) => line.includes('could not decide')))
      .join(' ')
      .replace(/\s+/gu, ' ')

    expect(errorLines).toContain('call[0].diamondCut[0].cuts[0].selectors[1]')
    expect(errorLines).toContain('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE')
    expect(errorLines).not.toContain('…')
  })

  it('does not report zero undecided calls as the reason it could not decide', () => {
    const [headline] = executabilityPanel(
      verdict({ error: true, errors: ['a selector was never looked up'] })
    )

    expect(stripAnsi(headline ?? '')).toContain('Simulation: INCONCLUSIVE')
    expect(stripAnsi(headline ?? '')).not.toContain('0 of 1')
  })
})

describe('a finding under the call it belongs to', () => {
  it('does not restate the path the heading and the marker already carry', () => {
    const plain = executabilityPanel(
      verdict({
        refuses: true,
        calls: [
          call({
            outcome: 'would-revert',
            findings: [
              finding({
                path: 'call[0].cuts[0].selectors[1]',
                detail:
                  'call[0].cuts[0].selectors[1] replaces 0x1794958f with 0xfacet, which already serves it',
              }),
            ],
          }),
        ],
      })
    ).map(stripAnsi)

    const joined = plain.join(' ')
    expect(joined).toContain('cuts[0].selectors[1] — replaces 0x1794958f')
    expect(joined.match(/cuts\[0\]\.selectors\[1\]/gu)).toHaveLength(1)
  })

  it('says how far the finding can be trusted', () => {
    const plain = executabilityPanel(
      verdict({
        refuses: true,
        calls: [call({ outcome: 'would-revert', findings: [finding()] })],
      })
    ).map(stripAnsi)

    expect(plain.join(' ')).toContain('(proven)')
  })
})

describe('the panel fits the view', () => {
  it('fills the check block the view actually leaves it', () => {
    expect(PANEL_WIDTH).toBe(VIEW_WIDTH - CHECK_BLOCK_INDENT)
    // A literal floor beside the relation: the relation alone holds just as
    // well if both shrink to nothing, and every width assertion below is
    // expressed in PANEL_WIDTH, so all of them would move with it.
    expect(PANEL_WIDTH).toBeGreaterThanOrEqual(60)
  })

  const wide = (): readonly string[] =>
    executabilityPanel(
      verdict({
        refuses: true,
        calls: [
          call({
            modelled: false,
            description: 'scheduleBatch',
            outcome: 'would-revert',
            simulation: 'reverted',
            simulationDetail: VIEM_REVERT,
            findings: [
              finding({
                detail: `replaces 0xa1f1ce43 with 0x${'c'.repeat(
                  200
                )} on chain`,
              }),
            ],
          }),
        ],
      })
    )

  it('wraps every line inside the width, hex words included', () => {
    // The unmodelled caveat is what pushed the sender line past the rule: a
    // case that only ever asserted on a modelled call never drew it.
    expect(wide().map(stripAnsi).join(' ')).toContain('no revert model')
    for (const line of wide().map(stripAnsi))
      expect(line.length).toBeLessThanOrEqual(PANEL_WIDTH)
  })

  it('leaves no colour reset on a line that was never coloured', () => {
    const opener = new RegExp(`${ESC}\\[[1-9][0-9]*m`, 'u')
    const orphans = wide().filter(
      (line) => line.includes(`${ESC}[0m`) && !opener.test(line)
    )

    // Paired with a present: a suite that only counted orphans would also pass
    // against a panel that had stopped colouring anything at all.
    expect(wide().filter((line) => opener.test(line)).length).toBeGreaterThan(2)
    expect(orphans).toEqual([])
  })
})

describe('executabilityNotes', () => {
  it('indents every drawn line into the check block and leaves blanks blank', () => {
    const notes = executabilityNotes(verdict())
    const drawn = notes.filter((line) => line.trim() !== '')

    expect(drawn.length).toBeGreaterThan(2)
    for (const line of drawn)
      expect(line.startsWith(' '.repeat(CHECK_BLOCK_INDENT))).toBe(true)
    // Blank separators stay empty rather than becoming a line of spaces, which
    // reads as a stray indent in a terminal that shows trailing whitespace.
    for (const line of notes.filter((l) => l.trim() === ''))
      expect(line).toBe('')
  })

  it('stays inside the view once indented', () => {
    for (const line of executabilityNotes(
      verdict({
        refuses: true,
        calls: [
          call({
            outcome: 'would-revert',
            simulation: 'reverted',
            simulationDetail: VIEM_REVERT,
          }),
        ],
      })
    ))
      expect(stripAnsi(line).length).toBeLessThanOrEqual(VIEW_WIDTH)
  })
})

describe('condensing what the collector already summarised', () => {
  /**
   * Built by calling `summariseRpcError`, never hand-typed.
   *
   * An earlier version of this block wrote out what the collector's output was
   * assumed to look like. The guess was wrong in a way the tests could not see
   * — its `Details:` sat mid-line rather than at the start of one — so it
   * exercised a shape the collector never produces, and went on passing while
   * the real pipeline did something else.
   */
  const viemError = (short: string, details: string): string =>
    [
      short,
      '',
      'Raw Call Arguments:',
      '  from:  0x743b11478D69C18693F41f25051a10DD4D1a6F39',
      `  data:  0x8f2a0bb${'0'.repeat(400)}1841`,
      '',
      `Details: ${details}`,
      'Version: viem@2.55.19',
    ].join('\n')

  const REDUNDANT = viemError(
    'Execution reverted with reason: TimelockController: insufficient delay.',
    'execution reverted: TimelockController: insufficient delay'
  )
  const INFORMATIVE = viemError(
    'Execution reverted for an unknown reason.',
    'out of gas'
  )

  it('says the reason once when the node restated it', () => {
    const condensed = condenseNodeMessage(summariseRpcError(REDUNDANT))

    expect(condensed).toBe(
      'Execution reverted with reason: TimelockController: insufficient delay.'
    )
    expect(condensed.match(/insufficient delay/gu)).toHaveLength(1)
  })

  it('keeps a Details line that says something the reason does not', () => {
    // The regression this module actually had: cutting at `Details:` threw away
    // `out of gas` — the only diagnostic on a revert whose other line is
    // "for an unknown reason". What to drop is the collector's judgement, and
    // duplicating it here is how the two fell out of step.
    expect(condenseNodeMessage(summariseRpcError(INFORMATIVE))).toContain(
      'out of gas'
    )
  })

  it('gives the same answer whether or not the collector ran first', () => {
    for (const raw of [REDUNDANT, INFORMATIVE])
      expect(condenseNodeMessage(summariseRpcError(raw))).toBe(
        condenseNodeMessage(raw)
      )
  })

  it('drops the echoed calldata on either path', () => {
    for (const message of [REDUNDANT, summariseRpcError(REDUNDANT)]) {
      const condensed = condenseNodeMessage(message)
      expect(condensed).not.toContain('Raw Call Arguments')
      expect(condensed).not.toContain('0'.repeat(60))
      expect(condensed).toContain('insufficient delay')
    }
  })
})
