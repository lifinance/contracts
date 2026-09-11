import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { classifyContentVerdict } from './closure-drift'

const SUBJECT = 'ERC20Proxy@1.2.0'

describe('classifyContentVerdict', () => {
  it('passes when the whole closure matches the audit', () => {
    const result = classifyContentVerdict(SUBJECT, {
      ownSourceMatches: true,
      closureMatches: true,
      driftingDependencies: [],
    })

    expect(result.verdict).toBe('pass')
    expect(result.blocksMerge).toBe(false)
  })

  it("fails when the contract's own source differs", () => {
    const result = classifyContentVerdict(SUBJECT, {
      ownSourceMatches: false,
      closureMatches: false,
      driftingDependencies: ['src/Periphery/ERC20Proxy.sol'],
    })

    expect(result.verdict).toBe('fail')
    expect(result.blocksMerge).toBe(true)
    expect(result.reason).toMatch(/not the audited contract/)
  })

  it('reports drift without blocking when only the closure moved', () => {
    // Measured on real data: 4 of 6 files in ERC20Proxy's closure were
    // comment-only drift and normalise away; GenericErrors.sol and LibBytes.sol
    // each gained an error, which is real code in a shared library.
    const result = classifyContentVerdict(SUBJECT, {
      ownSourceMatches: true,
      closureMatches: false,
      driftingDependencies: [
        'src/Errors/GenericErrors.sol',
        'src/Libraries/LibBytes.sol',
      ],
    })

    expect(result.verdict).toBe('closure-drift')
    expect(result.blocksMerge).toBe(false)
    expect(result.reason).toContain('2 file(s)')
    expect(result.reason).toContain('src/Errors/GenericErrors.sol')
    expect(result.reason).toContain('src/Libraries/LibBytes.sol')
  })

  it('lets the own-source failure win when both differ', () => {
    // Ordering matters: reported-not-blocking must never be reachable for a
    // contract whose own source changed, or a real edit merges as drift.
    const result = classifyContentVerdict(SUBJECT, {
      ownSourceMatches: false,
      closureMatches: false,
      driftingDependencies: ['src/Libraries/LibAsset.sol'],
    })

    expect(result.verdict).toBe('fail')
    expect(result.blocksMerge).toBe(true)
  })

  it('names the first few drifting files and counts the rest', () => {
    const many = Array.from(
      { length: 9 },
      (_, i) => `src/Libraries/Lib${i}.sol`
    )
    const result = classifyContentVerdict(SUBJECT, {
      ownSourceMatches: true,
      closureMatches: false,
      driftingDependencies: many,
    })

    expect(result.reason).toContain('9 file(s)')
    expect(result.reason).toContain('src/Libraries/Lib0.sol')
    expect(result.reason).toContain('and 4 more')
    // The sixth onward are counted, not listed — a CI line naming 40 libraries
    // is a line nobody reads.
    expect(result.reason).not.toContain('src/Libraries/Lib7.sol')
  })

  it('blocks on exactly one of the three verdicts', () => {
    const blocking = (
      [
        [true, true, []],
        [true, false, ['src/Errors/GenericErrors.sol']],
        [false, false, ['src/Periphery/ERC20Proxy.sol']],
      ] as const
    ).map(([own, closure, drifting]) =>
      classifyContentVerdict(SUBJECT, {
        ownSourceMatches: own,
        closureMatches: closure,
        driftingDependencies: [...drifting],
      })
    )

    expect(blocking.map((r) => r.verdict)).toEqual([
      'pass',
      'closure-drift',
      'fail',
    ])
    expect(blocking.map((r) => r.blocksMerge)).toEqual([false, false, true])
  })
})
