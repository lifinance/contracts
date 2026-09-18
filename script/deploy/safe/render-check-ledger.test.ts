import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  createCheckLedger,
  recordCheck,
  type ICheckDefinition,
  type ICheckLedger,
  type ICheckResult,
} from './check-ledger'
import { renderCheckLedger } from './render-check-ledger'

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'

const CODEHASH: ICheckDefinition = {
  checkId: 'codehash',
  section: 'Integrity',
  checkClass: 'integrity',
  gate: 'X',
  title: 'Deployed codehash',
}

const TARGET_STATE: ICheckDefinition = {
  checkId: 'target-state',
  section: 'Intent',
  checkClass: 'semantic',
  gate: 'Y',
  title: 'Facet version',
}

/** A second check in `CODEHASH`'s section, so a section can be partly green. */
const AUTHORITY: ICheckDefinition = {
  checkId: 'authority',
  section: 'Integrity',
  checkClass: 'integrity',
  gate: 'Z',
  title: 'Timelock owns the diamond',
}

const ledgerOf = (
  networks: string[],
  checks: ICheckDefinition[] = [CODEHASH, TARGET_STATE]
): ICheckLedger => createCheckLedger({ expectedNetworks: networks, checks })

const result = (over: Partial<ICheckResult> = {}): ICheckResult => ({
  checkId: 'codehash',
  network: 'mainnet',
  status: 'pass',
  expected: '0xaaa',
  actual: '0xaaa',
  anchor: 'A-CI',
  ...over,
})

/**
 * The one expanded row for a network.
 *
 * Matches the network column exactly rather than by substring: eight real
 * network names are substrings of others (`arbitrum` inside `arbitrumnova`,
 * `base` inside `basecamp`), so a substring match would silently return the
 * wrong row — or several — the moment a test uses real names.
 */
const rowFor = (lines: string[], network: string): string => {
  const header = new RegExp(`^\\u001b\\[\\d+m {6}${network}\\s`)
  const starts = lines.flatMap((line, at) => (header.test(line) ? [at] : []))
  expect(starts).toHaveLength(1)
  const start = starts[0] as number

  // The header plus every value and remedy line indented under it.
  const block = [lines[start] as string]
  for (const line of lines.slice(start + 1)) {
    if (!/^ {8}/.test(stripColor(line))) break
    block.push(line)
  }
  return block.join('\n')
}

const ESC = String.fromCharCode(27)
const stripColor = (line: string): string =>
  line.replace(new RegExp(`${ESC}[[][0-9;]*m`, 'g'), '')

/** The closing verdict, however many lines it folded onto. */
const verdictOf = (lines: string[]): string => {
  const fromEnd = [...lines]
    .reverse()
    .findIndex((line) => stripColor(line).startsWith('VERDICT:'))
  const start = fromEnd === -1 ? -1 : lines.length - 1 - fromEnd
  expect(start).toBeGreaterThan(-1)
  return lines.slice(start).join(' ')
}

/** The whole report is the closing verdict: its first line and its folds. */
const closingOnly = (lines: string[]): string => {
  expect(stripColor(lines[0] ?? '')).toStartWith('VERDICT: ')
  for (const line of lines.slice(1)) expect(stripColor(line)).toMatch(/^ {9}\S/)
  return lines.join(' ')
}

/** The shared-cause banner, however many lines it folded onto. */
const bannerOf = (lines: string[]): { at: number; text: string } => {
  const at = lines.findIndex((line) => line.includes('⚠'))
  expect(at).toBeGreaterThan(-1)
  const block = [lines[at] as string]
  for (const line of lines.slice(at + 1)) {
    if (!/^ {4}\S/.test(stripColor(line))) break
    block.push(line)
  }
  return { at, text: block.join(' ') }
}

describe('renderCheckLedger', () => {
  it('collapses a fully green section to one line and names no network', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(ledger, result({ network: 'polygon' }))

    const lines = renderCheckLedger(ledger)
    const section = lines.filter((line) => line.includes('Integrity'))

    expect(section).toHaveLength(1)
    expect(section[0]).toContain('1/1 applicable checks green')
    expect(section[0]).toContain('2/2')
    expect(section[0]).toContain(GREEN)
    expect(lines.some((line) => line.includes('mainnet'))).toBe(false)
    expect(lines.some((line) => line.includes('polygon'))).toBe(false)
    expect(verdictOf(lines)).toContain('ALL CHECKS GREEN')
  })

  it('expands only the non-green rows of a non-green check', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(
      ledger,
      result({ network: 'polygon', status: 'fail', actual: '0xbbb' })
    )

    const lines = renderCheckLedger(ledger)

    expect(lines.some((line) => line.includes('mainnet'))).toBe(false)
    const row = rowFor(lines, 'polygon')
    expect(row).toContain('MISMATCH')
    expect(row).toContain('expected  0xaaa')
    expect(row).toContain('observed  0xbbb')
    expect(row).toContain(RED)
  })

  it('renders pass, fail and error as three visibly different things', () => {
    const ledger = ledgerOf(['mainnet', 'polygon', 'arbitrum'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(
      ledger,
      result({ network: 'polygon', status: 'fail', actual: '0xbbb' })
    )
    recordCheck(
      ledger,
      result({
        network: 'arbitrum',
        status: 'error',
        actual: 'no answer',
        anchor: 'A-UNRESOLVED',
        detail: 'RPC timeout',
      })
    )

    const lines = renderCheckLedger(ledger)
    const failRow = rowFor(lines, 'polygon')
    const errorRow = rowFor(lines, 'arbitrum')

    expect(failRow).toContain('MISMATCH')
    expect(failRow).not.toContain('UNVERIFIED')
    expect(failRow).toContain(RED)

    expect(errorRow).toContain('UNVERIFIED')
    expect(errorRow).toContain('could not run')
    expect(errorRow).toContain('RPC timeout')
    expect(errorRow).not.toContain('MISMATCH')
    expect(errorRow).not.toContain(GREEN)
    expect(errorRow).toContain(YELLOW)

    const checkLine = lines.find((line) => line.includes('codehash'))
    expect(checkLine).toContain('1/3 network results verified')
    expect(checkLine).toContain('1 mismatch')
    expect(checkLine).toContain('1 unverified')
    expect(checkLine).not.toContain('✓')
  })

  it('states the next action on every non-green row', () => {
    const failed = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(failed, result({ status: 'fail', actual: '0xbbb' }))

    const errored = ledgerOf(['polygon'], [CODEHASH])
    recordCheck(
      errored,
      result({ network: 'polygon', status: 'error', anchor: 'A-UNRESOLVED' })
    )

    const awaitingAck = ledgerOf(['arbitrum'], [TARGET_STATE])
    recordCheck(
      awaitingAck,
      result({
        network: 'arbitrum',
        checkId: 'target-state',
        status: 'needs-ack',
      })
    )

    expect(rowFor(renderCheckLedger(failed), 'mainnet')).toContain(
      '→ do not sign'
    )
    expect(rowFor(renderCheckLedger(errored), 'polygon')).toContain('→ retry')
    expect(rowFor(renderCheckLedger(awaitingAck), 'arbitrum')).toContain(
      '→ review'
    )
  })

  it('cannot render a 56-of-57 as a green line', () => {
    const networks = Array.from({ length: 57 }, (_, i) => `net${i}`)
    const ledger = ledgerOf(networks, [CODEHASH])
    for (const network of networks.slice(0, 56))
      recordCheck(ledger, result({ network }))

    const lines = renderCheckLedger(ledger)
    const checkLine = lines.find((line) => line.includes('codehash'))
    const section = lines.find((line) => line.includes('Integrity'))

    expect(checkLine).toContain('56/57 network results verified')
    expect(checkLine).toContain('1 unverified')
    expect(section).not.toContain('✓')
    expect(section).not.toContain(GREEN)
    expect(verdictOf(lines)).toContain('BLOCKED')
  })

  it('names a network that reported nothing rather than omitting it', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))

    const row = rowFor(renderCheckLedger(ledger), 'polygon')

    expect(row).toContain('UNVERIFIED')
    expect(row).toContain('no result recorded')
    expect(row).toContain('→ re-run this check')
  })

  it('blocks on an integrity FAIL and says the ack path does not exist', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))

    const verdict = verdictOf(renderCheckLedger(ledger))

    expect(verdict).toContain('BLOCKED')
    expect(verdict).toContain('1 blocking')
    expect(verdict).toContain('no acknowledgement path')
    expect(verdict).toContain(RED)
  })

  it('asks for an acknowledgement, not a block, on a semantic FAIL alone', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'fail', actual: '1.0.1' })
    )

    const verdict = verdictOf(renderCheckLedger(ledger))

    expect(verdict).toContain('ACKNOWLEDGEMENT REQUIRED')
    expect(verdict).not.toContain('BLOCKED')
  })

  it('names what triage relaxed instead of dropping it silently', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'needs-ack',
        actual: 'not targeted on this network',
      })
    )

    const lines = renderCheckLedger(ledger, { triageProfile: 'subtractive' })
    const row = rowFor(lines, 'mainnet')

    expect(row).toContain('relaxed by triage')
    expect(verdictOf(lines)).toContain('NO BLOCKING RESULT')
    expect(verdictOf(lines)).toContain('1 relaxed by triage')
    expect(verdictOf(lines)).not.toContain('BLOCKED —')
  })

  it('keeps a semantic MISMATCH out of triage and off the do-not-sign line', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'fail', actual: '1.0.1' })
    )

    const lines = renderCheckLedger(ledger, { triageProfile: 'subtractive' })
    const row = rowFor(lines, 'mainnet')

    expect(row).toContain('MISMATCH')
    expect(row).not.toContain('relaxed by triage')
    // The verdict below it says an acknowledgement is what is missing, so the
    // row must not tell the signer the opposite.
    expect(row).not.toContain('do not sign')
    expect(row).toContain('→ review the disagreement')
    expect(verdictOf(lines)).toContain('ACKNOWLEDGEMENT REQUIRED')
  })

  it('tells the signer not to sign only on an integrity mismatch', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))

    expect(rowFor(renderCheckLedger(ledger), 'mainnet')).toContain(
      '→ do not sign'
    )
  })

  it('marks a relaxed NEEDS REVIEW row as relaxed too, not as still pending', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'needs-ack',
        actual: 'not targeted on this network',
      })
    )

    const lines = renderCheckLedger(ledger, { triageProfile: 'subtractive' })
    const row = rowFor(lines, 'mainnet')

    expect(row).toContain('NEEDS REVIEW · relaxed by triage')
    expect(row).not.toContain('→ review the change')
    expect(verdictOf(lines)).toContain('1 relaxed by triage')
  })

  it('keeps blocking an integrity FAIL under --triage', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))

    const lines = renderCheckLedger(ledger, { triageProfile: 'subtractive' })

    expect(verdictOf(lines)).toContain('BLOCKED')
    expect(rowFor(lines, 'mainnet')).not.toContain('relaxed by triage')
  })

  it('neutralises escape sequences carried by a recorded value', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(
      ledger,
      result({
        status: 'fail',
        actual: '\u001b[32mfake pass\nsecond line',
      })
    )

    const lines = renderCheckLedger(ledger)
    const row = rowFor(lines, 'mainnet')

    expect(row).not.toContain('\u001b[32mfake pass')
    expect(row).toContain('[32mfake pass second line')
    // The value's own line break was folded into a space, so it stays on the
    // observed line instead of opening a line of its own.
    const observed = row
      .split('\n')
      .filter((line) => line.includes('fake pass'))
    expect(observed).toHaveLength(1)
    expect(observed[0]).toContain('observed  [32mfake pass second line')
  })

  it('reports one section line per section, in check-registration order', () => {
    const ledger = ledgerOf(['mainnet'])
    recordCheck(ledger, result())
    recordCheck(ledger, result({ checkId: 'target-state' }))

    const sections = renderCheckLedger(ledger).filter(
      (line) => line.includes('Integrity') || line.includes('Intent')
    )

    expect(sections).toHaveLength(2)
    expect(sections[0]).toContain('Integrity')
    expect(sections[1]).toContain('Intent')
  })

  it('expands the right row when network names are substrings of each other', () => {
    const ledger = ledgerOf(
      ['arbitrum', 'arbitrumnova', 'arbitrumsepolia'],
      [CODEHASH]
    )
    const codehash =
      '0x9c0d3ba1b0e0d0a1c0f0e0d0c0b0a09080706050403020100ffeeddccbbaa9988'

    recordCheck(
      ledger,
      result({ network: 'arbitrum', expected: codehash, actual: codehash })
    )
    recordCheck(
      ledger,
      result({ network: 'arbitrumnova', expected: codehash, actual: codehash })
    )
    recordCheck(
      ledger,
      result({
        network: 'arbitrumsepolia',
        status: 'fail',
        expected: codehash,
        actual: `${codehash.slice(0, 64)}0000`,
      })
    )

    const lines = renderCheckLedger(ledger)
    const row = rowFor(lines, 'arbitrumsepolia')

    expect(row).toContain('MISMATCH')
    expect(row).toContain(codehash)
    // The two passing networks stay collapsed, including the one whose name is
    // a prefix of the failing one.
    expect(() => rowFor(lines, 'arbitrum')).toThrow()
    expect(() => rowFor(lines, 'arbitrumnova')).toThrow()
  })

  it('sanitizes the title, not only the values', () => {
    const ledger = ledgerOf(
      ['mainnet'],
      [
        {
          ...CODEHASH,
          checkId: '\u001b[32mcodehash',
          title: '\u001b[32mall green',
        },
      ]
    )
    recordCheck(
      ledger,
      result({ checkId: '\u001b[32mcodehash', status: 'fail', actual: '0xbbb' })
    )

    const lines = renderCheckLedger(ledger)
    const checkLine = lines.find((line) => line.includes('all green')) as string

    expect(checkLine).toContain('[32mall green')
    expect(checkLine).not.toContain('[32mall green')
    // The id is for the source, not the screen: it is printed nowhere.
    expect(lines.some((line) => line.includes('codehash'))).toBe(false)
  })

  it('names an outstanding acknowledgement on the section line', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'needs-ack',
        actual: 'not targeted on this network',
      })
    )

    const section = renderCheckLedger(ledger).find((line) =>
      line.includes('Intent')
    ) as string

    expect(section).toContain('1 needs review')
    expect(section).not.toContain('blocking')
  })

  it('counts an unverified row once on the section line, not twice', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(
      ledger,
      result({ status: 'error', anchor: 'A-UNRESOLVED', detail: 'RPC timeout' })
    )

    const section = renderCheckLedger(ledger).find((line) =>
      line.includes('Integrity')
    ) as string

    // One errored network plus one that never reported: two problem rows.
    expect(section).toContain('2 unverified')
    expect(section).not.toContain('blocking mismatch')
  })

  it('reports mixed verdicts within one section', () => {
    const ledger = createCheckLedger({
      expectedNetworks: ['mainnet'],
      checks: [
        CODEHASH,
        {
          ...CODEHASH,
          checkId: 'codehash-immutables',
          checkClass: 'semantic',
          title: 'Immutable values',
        },
      ],
    })

    recordCheck(ledger, result())
    recordCheck(
      ledger,
      result({
        checkId: 'codehash-immutables',
        status: 'fail',
        actual: '0xbbb',
      })
    )

    const lines = renderCheckLedger(ledger)
    const section = lines.find((line) => line.includes('Integrity')) as string

    expect(section).toContain('1/2 applicable checks green')
    expect(section).toContain('1/2 network results verified')
    expect(
      lines.filter((line) => line.includes('Immutable values'))
    ).toHaveLength(1)
    expect(lines.some((line) => line.includes('Deployed codehash'))).toBe(false)
  })

  it('opens with a header naming the coverage denominator', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(ledger, result({ network: 'polygon' }))

    expect(renderCheckLedger(ledger)[0]).toContain(
      'Check Ledger — 1 check × 2 networks'
    )
  })
})

describe('what the ledger must never soften or hide', () => {
  it('does not let a milder result erase a recorded mismatch', () => {
    // A mismatch may not be erased by a milder result on the same
    // (check, network): erased, it becomes eligible for a triage relaxation the
    // rules forbid for a fail. Semantic only; integrity coerces needs-ack to
    // fail.
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'fail',
        expected: 'facet 0xaa',
        actual: 'facet 0xdeadbeef',
      })
    )
    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'needs-ack' })
    )

    const lines = renderCheckLedger(ledger, { triageProfile: 'subtractive' })

    expect(verdictOf(lines)).not.toContain('NO BLOCKING RESULT')
    expect(rowFor(lines, 'mainnet')).not.toContain('relaxed by triage')
    // Paired presence: the mismatch is still reported, not merely un-relaxed.
    expect(rowFor(lines, 'mainnet')).toContain('MISMATCH')
  })

  it('refuses to summarise a ledger that verified nothing', () => {
    // `createCheckLedger` guards this, but every consumer takes a plain
    // `ICheckLedger`, so a rehydrated document reaches the verdict with an empty
    // network set and every count over it is a count over nothing.
    const empty = {
      expectedNetworks: [],
      checks: new Map([[CODEHASH.checkId, CODEHASH]]),
      results: [],
    } as unknown as ICheckLedger

    expect(() => renderCheckLedger(empty)).toThrow(/verifies nothing/)
  })

  it('renders an unrecognised status as unverified, the way the verdict grades it', () => {
    // The row and the verdict have to grade it the same way: unverified, with
    // no acknowledgement path offered.
    // `recordCheck` validates the status, so this is only reachable by
    // bypassing it — a rehydrated document or a direct push, the same route
    // that let an empty ledger render green.
    const rehydrated = {
      expectedNetworks: ['mainnet'],
      checks: new Map([[CODEHASH.checkId, CODEHASH]]),
      results: [
        result({ status: 'verified' as unknown as ICheckResult['status'] }),
      ],
    } as unknown as ICheckLedger

    const row = rowFor(renderCheckLedger(rehydrated), 'mainnet')

    expect(row).toContain('UNVERIFIED')
    expect(row).not.toContain('MISMATCH')
    // It must say there is no acknowledgement path, not offer one. A bare
    // `not.toContain('acknowledge')` fails the correct message, which has to
    // use the word to deny it.
    expect(row).toContain('no acknowledgement path')
    expect(row).not.toMatch(/→ review the/)
  })

  it('names a semantic mismatch on the section line', () => {
    // A semantic value that disagreed has to appear in a term on the line a
    // signer skims, not only in the expanded row.
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'fail', actual: '0xbbb' })
    )

    const section = renderCheckLedger(ledger).find((line) =>
      line.includes('Intent')
    )

    expect(section).toContain('1 mismatch')
    // Not "blocking": this one is acknowledgeable, and the verdict below says
    // so.
    expect(section).not.toContain('blocking')
  })

  it('prints no anchor, injected or not', () => {
    // `recordCheck` validates the anchor against ANCHOR_IDS, so an injected one
    // is only reachable through the rehydration path. The anchor names a
    // source for the reader of the source, so the screen carries neither it
    // nor anything smuggled in through it.
    const esc = String.fromCharCode(27)
    const rehydrated = {
      expectedNetworks: ['mainnet'],
      checks: new Map([[CODEHASH.checkId, CODEHASH]]),
      results: [
        result({
          status: 'fail',
          actual: '0xbbb',
          anchor: `A-CI${esc}[32mGREEN` as unknown as ICheckResult['anchor'],
        }),
      ],
    } as unknown as ICheckLedger

    const lines = renderCheckLedger(rehydrated)

    expect(lines.some((line) => line.includes(`${esc}[32mGREEN`))).toBe(false)
    expect(lines.some((line) => line.includes('A-CI'))).toBe(false)
    // Paired presence: the row itself is still there to be read.
    expect(rowFor(lines, 'mainnet')).toContain('observed  0xbbb')
  })

  it('sanitises every field a foreign value reaches the terminal through', () => {
    // Every field a foreign value arrives through. `detail` is the likeliest,
    // since it carries RPC and store error strings from outside this process.
    const esc = String.fromCharCode(27)
    const injected = `${esc}[32mGREEN`
    const ledger = createCheckLedger({
      expectedNetworks: [`mainnet${injected}`],
      checks: [{ ...CODEHASH, section: `Integrity${injected}` }],
    })
    recordCheck(
      ledger,
      result({
        network: `mainnet${injected}`,
        status: 'error',
        detail: `rpc down ${injected}`,
      })
    )

    const lines = renderCheckLedger(ledger)

    for (const line of lines) expect(line).not.toContain(`${esc}[32m`)
    // Paired presence: the values still appear, so sanitising has not silently
    // dropped what a signer needs to identify the row.
    expect(lines.join('\n')).toContain('GREEN')
  })
})

describe('the closing line always carries the coverage figure', () => {
  it('reports N/N when blocked, not only when green', () => {
    // A verdict line that shows the denominator only on success hides it in
    // exactly the case that matters — the run that verified 56 of 57.
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(
      ledger,
      result({ network: 'polygon', status: 'fail', actual: '0xbbb' })
    )

    const verdict = verdictOf(renderCheckLedger(ledger))

    expect(verdict).toContain('BLOCKED')
    expect(verdict).toContain('1/2 network results verified')
    // A signer cannot resolve an internal ruling id.
    expect(verdict).not.toContain('(T3)')
  })

  it('reports N/N when a review is awaited', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [TARGET_STATE])
    recordCheck(ledger, result({ checkId: 'target-state', network: 'mainnet' }))
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        network: 'polygon',
        status: 'needs-ack',
      })
    )

    const verdict = verdictOf(renderCheckLedger(ledger))

    expect(verdict).toContain('ACKNOWLEDGEMENT REQUIRED')
    expect(verdict).toContain('1/2 network results verified')
  })

  it('reports N/N when triage cleared the only review', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [TARGET_STATE])
    recordCheck(ledger, result({ checkId: 'target-state', network: 'mainnet' }))
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        network: 'polygon',
        status: 'needs-ack',
      })
    )

    const verdict = verdictOf(
      renderCheckLedger(ledger, { triageProfile: 'subtractive' })
    )

    expect(verdict).toContain('NO BLOCKING RESULT')
    expect(verdict).toContain('1/2 network results verified')
  })
})

describe('a superseded mismatch stays visible', () => {
  it('names the earlier disagreement on the row that replaced it', () => {
    // One row per network is what the verdict needs, and it cannot hold both
    // "it disagreed" and "the retry could not run". The verdict blocks either
    // way; what changes is the guidance — "retry this" reads differently for a
    // network that has already disagreed once.
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'fail',
        expected: 'facet 0xaaa',
        actual: 'facet 0xdeadbeef',
      })
    )
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'error',
        detail: 'rpc unreachable on retry',
      })
    )

    const row = rowFor(renderCheckLedger(ledger), 'mainnet')

    expect(row).toContain('UNVERIFIED')
    expect(row).toContain('an earlier attempt disagreed')
    expect(row).toContain('facet 0xdeadbeef')
    expect(row).toContain('rpc unreachable on retry')
  })

  it('says nothing about a supersession that did not happen', () => {
    // Paired absence: an error with no prior mismatch must not claim one, or
    // the note would appear on every retried network.
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'error', detail: 'rpc down' })
    )

    expect(rowFor(renderCheckLedger(ledger), 'mainnet')).not.toContain(
      'an earlier attempt disagreed'
    )
  })
})

describe('the superseded mismatch survives more than one retry', () => {
  it('still names the disagreement after a second failed retry', () => {
    // The note is keyed on the network for the whole run, so it survives any
    // number of failed retries. Two in a row on a flaky endpoint is the
    // ordinary case, not a corner.
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'fail',
        expected: 'facet 0xaaa',
        actual: 'facet 0xdeadbeef',
      })
    )
    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'error', detail: 'rpc down' })
    )
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'error',
        detail: 'rpc down again',
      })
    )

    const row = rowFor(renderCheckLedger(ledger), 'mainnet')

    expect(row).toContain('an earlier attempt disagreed')
    expect(row).toContain('facet 0xdeadbeef')
    expect(row).toContain('rpc down again')
  })

  it('will not repeat a disagreement a rehydrated row merely claims', () => {
    // The note asserts something about the ledger's own history, so an incoming
    // one is stripped rather than trusted — the digest names seven fields and
    // not this one, so a forged claim would be invisible to the attestation.
    const forged = {
      expectedNetworks: ['mainnet'],
      checks: new Map([[TARGET_STATE.checkId, TARGET_STATE]]),
      results: [
        {
          ...result({
            checkId: 'target-state',
            status: 'error',
            detail: 'rpc down',
          }),
          supersededMismatch:
            'an earlier attempt disagreed: expected X, observed X (anchor A-CI)',
        },
      ],
    } as unknown as ICheckLedger

    expect(rowFor(renderCheckLedger(forged), 'mainnet')).not.toContain(
      'an earlier attempt disagreed'
    )
  })
})

describe('a run that graded nothing', () => {
  /**
   * The row `confirm-safe-tx.ts` writes for a network it positively established
   * carries no proposal for this signer — a pending proposal the signer has
   * already signed is the case that produces it.
   */
  const nothingToGrade = (network: string): Partial<ICheckResult> => ({
    network,
    status: 'not-applicable',
    expected: 'every proposal this run would sign graded before signing',
    actual: `no proposal was graded on ${network} — nothing actionable was left once the network was prepared`,
    anchor: 'A-LOCAL',
  })

  const vacuous = (): ICheckLedger => {
    const ledger = ledgerOf(['arbitrum'], [CODEHASH])
    recordCheck(ledger, result(nothingToGrade('arbitrum')))

    return ledger
  }

  it('does not close with a green verdict', () => {
    const verdict = verdictOf(renderCheckLedger(vacuous()))

    expect(verdict).not.toContain('ALL CHECKS GREEN')
    expect(verdict).not.toContain(GREEN)
  })

  it('prints no verified count at all, rather than a vacuous one', () => {
    // `1/1 network results verified` over a set of size zero is the claim that
    // produced the defect, and `0/0` is the same claim in a quieter font.
    expect(verdictOf(renderCheckLedger(vacuous()))).not.toMatch(
      /\d+\/\d+ network results verified/
    )
  })

  it('names the skipped networks and why they were skipped', () => {
    const verdict = verdictOf(renderCheckLedger(vacuous()))

    expect(verdict).toContain('NOTHING TO REVIEW')
    expect(verdict).toContain('1 network')
    expect(verdict).toContain('nothing actionable was left')
  })

  it('prints the closing line and nothing else', () => {
    const lines = renderCheckLedger(vacuous())
    const closing = closingOnly(lines)

    expect(closing).toContain('NOTHING TO REVIEW')
    expect(closing).not.toContain('Check Ledger')
    expect(closing).not.toContain('Integrity')
    expect(closing).not.toContain('codehash')
  })

  it('prints the closing line alone across a fleet, not just one network', () => {
    // The shape a fleet run reaches this state in, and the reason the row here
    // is the not-an-owner one: the signer who loaded the wrong key sees this
    // line and nothing else, on every network at once.
    const networks = ['mainnet', 'arbitrum', 'polygon']
    const ledger = ledgerOf(networks, [CODEHASH, AUTHORITY])
    for (const network of networks)
      for (const checkId of ['codehash', 'authority'])
        recordCheck(
          ledger,
          result({
            checkId,
            network,
            status: 'not-applicable',
            expected:
              'every proposal this run would sign graded before signing',
            actual: `no proposal was graded on ${network} — the signer is not an owner of this Safe, so nothing here can be signed`,
            anchor: 'A-LOCAL',
          })
        )

    const closing = closingOnly(renderCheckLedger(ledger))

    expect(closing).toContain('NOTHING TO REVIEW')
    expect(closing).toContain('3 networks had nothing to grade')
    expect(closing).toContain('is not an owner of this Safe')
  })

  it('still prints the report once one network graded', () => {
    // A network that dropped out is a row inside the report, never a reason to
    // suppress it: the whole report is owed as soon as anything was graded.
    const ledger = ledgerOf(['mainnet', 'arbitrum'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet', status: 'fail' }))
    recordCheck(ledger, result(nothingToGrade('arbitrum')))

    const lines = renderCheckLedger(ledger)

    expect(lines[0]).toContain('Check Ledger')
    expect(lines.filter((line) => line.includes('Integrity'))).toHaveLength(1)
    expect(lines.filter((line) => line.includes('codehash'))).toHaveLength(1)
    expect(lines.join('\n')).toContain('mainnet')
  })

  it('still closes an all-green run with the green verdict', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(ledger, result({ network: 'polygon' }))

    const verdict = verdictOf(renderCheckLedger(ledger))

    expect(verdict).toContain('ALL CHECKS GREEN')
    expect(verdict).toContain('2/2 network results verified')
    expect(verdict).toContain(GREEN)
  })

  it('still blocks when a graded network failed beside a skipped one', () => {
    const ledger = ledgerOf(['mainnet', 'arbitrum'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet', status: 'fail' }))
    recordCheck(ledger, result(nothingToGrade('arbitrum')))

    const verdict = verdictOf(renderCheckLedger(ledger))

    expect(verdict).toContain('VERDICT: BLOCKED')
    expect(verdict).not.toContain('NOTHING TO REVIEW')
    expect(verdict).toContain(RED)
  })

  it('keeps a skipped network out of the verified count of a mixed run', () => {
    const ledger = ledgerOf(['mainnet', 'arbitrum'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(ledger, result(nothingToGrade('arbitrum')))

    const lines = renderCheckLedger(ledger)
    const section = lines.filter((line) => line.includes('Integrity'))

    // One network graded, one verified — never `2/2`, which reads the skipped
    // network as one this run checked.
    expect(section[0]).toContain('1/1 network results verified')
    expect(section[0]).toContain('1 network not applicable')
    expect(section[0]).not.toContain('2/2')
    expect(verdictOf(lines)).toContain('1/1 network results verified')
    expect(verdictOf(lines)).toContain('1 network not applicable')
    expect(verdictOf(lines)).not.toContain('2/2')
  })

  it('counts the skipped networks, not the rows they produced', () => {
    // One network, two checks: the closing line has to report one network with
    // nothing to grade rather than the two check×network rows behind it.
    const ledger = ledgerOf(['arbitrum'], [CODEHASH, AUTHORITY])
    recordCheck(ledger, result(nothingToGrade('arbitrum')))
    recordCheck(
      ledger,
      result({ ...nothingToGrade('arbitrum'), checkId: 'authority' })
    )

    const lines = renderCheckLedger(ledger)

    expect(verdictOf(lines)).toContain('1 network had nothing to grade')
    expect(verdictOf(lines)).not.toContain('2 network')
  })
})

describe('a check that graded nothing beside one that graded', () => {
  const mixed = (): ICheckLedger => {
    const ledger = ledgerOf(['arbitrum'], [CODEHASH, AUTHORITY])
    recordCheck(ledger, result({ network: 'arbitrum' }))
    recordCheck(
      ledger,
      result({
        checkId: 'authority',
        network: 'arbitrum',
        status: 'not-applicable',
        actual: 'no proposal was graded on arbitrum',
        anchor: 'A-LOCAL',
      })
    )

    return ledger
  }

  // The closing line and the section line four rows above it are read as one
  // sentence, so they must divide by the same thing. This pins the pair, not
  // either number alone: a change that teaches one of them to discount a gate
  // that stood down and not the other puts two different counts of "a check"
  // on one screen, which is the confusion the whole not-applicable verdict
  // exists to remove.
  it('closes on the same denominator the section line printed', () => {
    const lines = renderCheckLedger(mixed())
    const section = lines.find((line) => line.includes('Integrity')) as string
    const verdict = verdictOf(lines)

    expect(section).toContain('1/1 applicable checks green')
    expect(section).toContain('1 gate not applicable')
    expect(verdict).toContain('1/1 applicable checks')
    // The word a run with a real shortfall earns, and this run has none.
    expect(verdict).not.toContain('COVERAGE INCOMPLETE')
  })

  // Paired absence: the same shape, but the gate graded nothing because the
  // network never answered. That is a hole, and it must still read as one.
  it('still reports a shortfall when a check graded nothing with no answer', () => {
    const ledger = ledgerOf(['arbitrum'], [CODEHASH, AUTHORITY])
    recordCheck(ledger, result({ network: 'arbitrum' }))

    const verdict = verdictOf(renderCheckLedger(ledger))

    expect(verdict).not.toContain('ALL APPLICABLE CHECKS GREEN')
  })

  it('expands the check that graded nothing rather than suppressing it', () => {
    const authority = renderCheckLedger(mixed()).filter((line) =>
      line.includes('Timelock owns the diamond')
    )

    expect(authority).toHaveLength(1)
    // Named, but never with a count over an empty set.
    expect(authority[0]).not.toMatch(/\d+\/\d+/)
    expect(authority[0]).toContain('nothing to grade')
  })

  // The header line says a gate stood down; only the row under it says why,
  // and the why is the thing a signer opened the report to read. Suppressing
  // this row is what made "not applicable" and "not run" indistinguishable on
  // screen even once the ledger told them apart.
  it('prints the reason the gate stood down, not just that it did', () => {
    const row = renderCheckLedger(mixed()).find((line) =>
      line.includes('no proposal was graded on arbitrum')
    ) as string

    expect(row).toBeDefined()
    expect(row).toContain('NOT APPLICABLE')
    // One line, reason included, and no remedy: there is nothing to do.
    expect(row).not.toContain('→')
    // Paired absence: a row that needs nothing must not carry the vocabulary
    // of one that does.
    expect(row).not.toContain('UNVERIFIED')
    expect(row).not.toContain('do not sign')
  })

  it('still closes green when every check graded something', () => {
    const ledger = ledgerOf(['arbitrum'], [CODEHASH, AUTHORITY])
    recordCheck(ledger, result({ network: 'arbitrum' }))
    recordCheck(ledger, result({ checkId: 'authority', network: 'arbitrum' }))

    const verdict = verdictOf(renderCheckLedger(ledger))

    expect(verdict).toContain('ALL CHECKS GREEN')
    expect(verdict).toContain('2/2 checks')
    expect(verdict).toContain(GREEN)
  })
})

describe('unverified rows that all rest on one cause', () => {
  const NO_ENDPOINT = 'ETH_NODE_URI_ARBITRUM is not set'

  const unverified = (checkId: string, detail: string): ICheckResult =>
    result({
      checkId,
      network: 'arbitrum',
      status: 'error',
      expected: 'a reading',
      actual: 'nothing could be read',
      anchor: 'A-UNRESOLVED',
      detail,
    })

  it('names the cause once, above the rows it explains', () => {
    const ledger = ledgerOf(['arbitrum'])
    recordCheck(ledger, unverified('codehash', NO_ENDPOINT))
    recordCheck(ledger, unverified('target-state', NO_ENDPOINT))

    const lines = renderCheckLedger(ledger)
    const banner = bannerOf(lines)
    const firstRow = lines.findIndex((line) => line.includes('UNVERIFIED'))

    expect(banner.at).toBeLessThan(firstRow)
    expect(banner.text).toContain(NO_ENDPOINT)
    expect(banner.text).toContain('2 unverified results')
    // The advice the old report gave ten times over, contradicted once.
    expect(banner.text).toContain('will not change the answer')
  })

  it('still names the cause when a row beside them graded nothing', () => {
    // A not-applicable row is neither unverified nor a disagreement; it has
    // no cause to share and must not be counted as an empty second one.
    const ledger = ledgerOf(['arbitrum'], [CODEHASH, TARGET_STATE, AUTHORITY])
    recordCheck(ledger, unverified('codehash', NO_ENDPOINT))
    recordCheck(ledger, unverified('target-state', NO_ENDPOINT))
    recordCheck(
      ledger,
      result({
        checkId: 'authority',
        network: 'arbitrum',
        status: 'not-applicable',
        expected: 'every installed contract authorised',
        actual:
          'this proposal installs no contract whose authorities main declares',
        anchor: 'A-LOCAL',
      })
    )

    const banner = bannerOf(renderCheckLedger(ledger)).text

    expect(banner).toContain('will not change the answer')
    expect(banner).toContain('2 unverified results')
  })

  it('stays quiet when the rows do not share a cause', () => {
    const ledger = ledgerOf(['arbitrum'])
    recordCheck(ledger, unverified('codehash', NO_ENDPOINT))
    recordCheck(ledger, unverified('target-state', 'the store was unreachable'))

    expect(
      renderCheckLedger(ledger).filter((line) =>
        line.includes('will not change the answer')
      )
    ).toHaveLength(0)
  })

  it('stays quiet when something also disagreed', () => {
    // Two problems, not one. A banner naming the environment would send the
    // signer to fix a thing that was never the whole story.
    const ledger = ledgerOf(['arbitrum'])
    recordCheck(ledger, unverified('codehash', NO_ENDPOINT))
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        network: 'arbitrum',
        status: 'fail',
        anchor: 'A-MAIN',
      })
    )

    expect(
      renderCheckLedger(ledger).filter((line) =>
        line.includes('will not change the answer')
      )
    ).toHaveLength(0)
  })

  it('stays quiet for a single unverified row, which its own action covers', () => {
    const ledger = ledgerOf(['arbitrum'], [CODEHASH])
    recordCheck(ledger, unverified('codehash', NO_ENDPOINT))

    expect(
      renderCheckLedger(ledger).filter((line) =>
        line.includes('will not change the answer')
      )
    ).toHaveLength(0)
  })
})

describe('a ledger a signer can read without the source', () => {
  const plain = stripColor

  const IMMUTABLES: ICheckDefinition = {
    checkId: 'immutables',
    section: 'Deployed state',
    checkClass: 'integrity',
    gate: 'L',
    title: 'Immutable values match what config declares',
  }
  const STORAGE: ICheckDefinition = {
    checkId: 'storage-authority',
    section: 'Deployed state',
    checkClass: 'semantic',
    gate: 'G',
    title: 'Contract config matches what main declares',
  }
  const QUORUM: ICheckDefinition = {
    checkId: 'rpc-quorum',
    section: 'Evidence',
    checkClass: 'semantic',
    gate: 'J',
    title: 'Independent RPCs agree',
  }

  /**
   * One network, two proposals already reduced worst-first: the codehash row
   * is nonce 37's finding, the rest belong to nonce 38.
   */
  const fixture = (): ICheckLedger => {
    const ledger = ledgerOf(['gnosis'], [CODEHASH, IMMUTABLES, STORAGE, QUORUM])
    recordCheck(
      ledger,
      result({
        network: 'gnosis',
        status: 'fail',
        expected:
          'every address this proposal installs carrying bytecode an attested build produces',
        actual: `UNVERIFIABLE — no attested build is available: the deployment record names CalldataVerificationFacet@1.1.0 at 0x${'ab'.repeat(
          20
        )} but no CI artefact, local build or audit log carries a bytecode for that version, so the installed code has nothing to be compared against and the target cannot be graded either way`,
        anchor: 'A-AUDIT',
        detail: `the address this refers to is 0x${'ab'.repeat(20)}`,
        proposalNonce: '37',
      })
    )
    recordCheck(
      ledger,
      result({
        checkId: 'immutables',
        network: 'gnosis',
        status: 'error',
        expected: 'every immutable holds the value config declares',
        actual: 'the immutable layout could not be read',
        anchor: 'A-UNRESOLVED',
        proposalNonce: '38',
      })
    )
    recordCheck(
      ledger,
      result({
        checkId: 'storage-authority',
        network: 'gnosis',
        status: 'not-applicable',
        expected: 'nothing to compare',
        actual:
          'this proposal installs no contract whose authorities main declares',
        anchor: 'A-LOCAL',
        proposalNonce: '38',
      })
    )
    recordCheck(
      ledger,
      result({
        checkId: 'rpc-quorum',
        network: 'gnosis',
        status: 'needs-ack',
        expected: '2 independent providers agreeing',
        actual: '0 of 0 agreed — the providers could not be told apart',
        anchor: 'A-UNRESOLVED',
        detail:
          'an endpoint names its host as a bare IP address, which cannot be shown independent of a hostname endpoint that may resolve to it: give every endpoint a hostname, or declare a providerId so the endpoints are counted as one',
        proposalNonce: '38',
      })
    )
    return ledger
  }

  const isRowHeader = (line: string): boolean =>
    /^ {6}\S/u.test(line) && !/^ {8}/u.test(line)

  /** Every line under one gate's title line, header first. */
  const rowBlock = (lines: string[], gate: string): string[] => {
    const start = lines.findIndex((line) =>
      plain(line).includes(`Gate ${gate} ·`)
    )
    expect(start).toBeGreaterThan(-1)
    const block: string[] = []
    for (const line of lines.slice(start + 1)) {
      if (/^ {2}\S/u.test(plain(line)) || !plain(line).startsWith(' ')) break
      block.push(line)
    }
    return block
  }

  it('prints no identifier a signer would have to look up', () => {
    for (const line of renderCheckLedger(fixture()).map(plain)) {
      expect(line).not.toMatch(/\[[a-z-]+\]/u)
      expect(line).not.toMatch(/A-[A-Z]+/u)
      expect(line).not.toMatch(/\([a-z-]+\)/u)
      expect(line).not.toMatch(/\banchors?\b/u)
    }
  })

  it('keeps every line inside the view width', () => {
    for (const line of renderCheckLedger(fixture()))
      expect(plain(line).length).toBeLessThanOrEqual(140)
    // A fold lands between phrases, never between a count and its noun.
    for (const line of renderCheckLedger(fixture()))
      expect(plain(line)).not.toMatch(/ · \d+$/u)
  })

  it('names the gate by its label alone, in bold', () => {
    const lines = renderCheckLedger(fixture())
    const gate = lines.find((line) =>
      plain(line).includes('Gate X · Deployed codehash')
    ) as string

    expect(gate).toContain('[1mGate X · Deployed codehash')
    expect(plain(gate)).not.toContain('codehash]')
  })

  it('stacks expected and observed on their own lines, then one remedy', () => {
    const lines = renderCheckLedger(fixture())

    for (const gate of ['X', 'L', 'J']) {
      const block = rowBlock(lines, gate).map(plain)
      expect(block.filter(isRowHeader)).toHaveLength(1)
      expect(
        block.filter((line) => /^ {8}expected {2}\S/u.test(line))
      ).toHaveLength(1)
      expect(
        block.filter((line) => /^ {8}observed {2}\S/u.test(line))
      ).toHaveLength(1)
      expect(block.filter((line) => /^ {8}→ /u.test(line))).toHaveLength(1)
    }
  })

  it('says which proposal a reduced row speaks for', () => {
    const lines = renderCheckLedger(fixture())

    expect(plain(rowBlock(lines, 'X')[0] as string)).toContain('nonce 37')
    expect(plain(rowBlock(lines, 'L')[0] as string)).toContain('nonce 38')
  })

  it('renders a gate that stood down as one line with its reason and no remedy', () => {
    const block = rowBlock(renderCheckLedger(fixture()), 'G').map(plain)

    expect(block).toHaveLength(1)
    expect(block[0]).toContain('NOT APPLICABLE')
    expect(block[0]).toContain('installs no contract whose authorities')
    expect(block[0]).not.toContain('→')
  })

  it('wraps a long observed value under its label instead of running off', () => {
    const block = rowBlock(renderCheckLedger(fixture()), 'X').map(plain)
    const observed = block.findIndex((line) => /^ {8}observed {2}/u.test(line))

    expect(observed).toBeGreaterThan(-1)
    // Longer than one line, so a continuation hangs under the value column.
    expect(block[observed + 1]).toMatch(/^ {18}\S/u)
    expect(block.join(' ')).toContain('cannot be graded either way')
  })

  it('closes on the verdict, unchanged in meaning', () => {
    const last = plain(verdictOf(renderCheckLedger(fixture())))

    expect(last).toMatch(
      /^VERDICT: BLOCKED — 2 blocking results \(1 unverified, 1 integrity mismatch\)/u
    )
  })
})
