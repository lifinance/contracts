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
  const matches = lines.filter((line) =>
    new RegExp(`^\\u001b\\[\\d+m {6}${network}\\s`).test(line)
  )
  expect(matches).toHaveLength(1)
  return matches[0] as string
}

describe('renderCheckLedger', () => {
  it('collapses a fully green section to one line and names no network', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(ledger, result({ network: 'polygon' }))

    const lines = renderCheckLedger(ledger)
    const section = lines.filter((line) => line.includes('Integrity'))

    expect(section).toHaveLength(1)
    expect(section[0]).toContain('1/1 checks green')
    expect(section[0]).toContain('2/2')
    expect(section[0]).toContain(GREEN)
    expect(lines.some((line) => line.includes('mainnet'))).toBe(false)
    expect(lines.some((line) => line.includes('polygon'))).toBe(false)
    expect(lines.at(-1)).toContain('ALL CHECKS GREEN')
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
    expect(row).toContain('expected 0xaaa')
    expect(row).toContain('actual 0xbbb')
    expect(row).toContain('A-CI')
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
    expect(checkLine).toContain('pass 1/3')
    expect(checkLine).toContain('fail 1')
    expect(checkLine).toContain('unverified 1')
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

    expect(checkLine).toContain('pass 56/57')
    expect(checkLine).toContain('unverified 1')
    expect(section).not.toContain('✓')
    expect(section).not.toContain(GREEN)
    expect(lines.at(-1)).toContain('BLOCKED')
  })

  it('names a network that reported nothing rather than omitting it', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))

    const row = rowFor(renderCheckLedger(ledger), 'polygon')

    expect(row).toContain('UNVERIFIED')
    expect(row).toContain('no result recorded')
    expect(row).toContain('A-UNRESOLVED')
  })

  it('blocks on an integrity FAIL and says the ack path does not exist', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))

    const verdict = renderCheckLedger(ledger).at(-1) as string

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

    const verdict = renderCheckLedger(ledger).at(-1) as string

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
    expect(lines.at(-1)).toContain('NO BLOCKING RESULT')
    expect(lines.at(-1)).toContain('1 relaxed by triage')
    expect(lines.at(-1)).not.toContain('BLOCKED —')
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
    expect(lines.at(-1)).toContain('ACKNOWLEDGEMENT REQUIRED')
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
    expect(lines.at(-1)).toContain('1 relaxed by triage')
  })

  it('keeps blocking an integrity FAIL under --triage', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))

    const lines = renderCheckLedger(ledger, { triageProfile: 'subtractive' })

    expect(lines.at(-1)).toContain('BLOCKED')
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
    expect(row.split('\n')).toHaveLength(1)
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

  it('sanitizes the check id, the title and the anchor, not only the values', () => {
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

    const checkLine = renderCheckLedger(ledger).find((line) =>
      line.includes('codehash')
    ) as string

    expect(checkLine).toContain('[32mcodehash')
    expect(checkLine).not.toContain('\u001b[32mcodehash')
    expect(checkLine).not.toContain('\u001b[32mall green')
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
        { ...CODEHASH, checkId: 'codehash-immutables', checkClass: 'semantic' },
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

    expect(section).toContain('1/2 checks green')
    expect(section).toContain('1/2 network results verified')
    expect(
      lines.filter((line) => line.includes('codehash-immutables'))
    ).toHaveLength(1)
    expect(lines.some((line) => line.includes('✗ codehash —'))).toBe(false)
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

    expect(lines.at(-1)).not.toContain('NO BLOCKING RESULT')
    expect(rowFor(lines, 'mainnet')).not.toContain('relaxed by triage')
    // Paired presence: the mismatch is still reported, not merely un-relaxed.
    expect(rowFor(lines, 'mainnet')).toContain('MISMATCH')
  })

  it('refuses to summarise a ledger that verified nothing', () => {
    // `createCheckLedger` guards this, but every consumer takes a plain
    // `ICheckLedger`, so a rehydrated document reached the verdict with
    // `passed === expected` as `0 === 0` and rendered ALL CHECKS GREEN.
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

  it('sanitises the anchor on the check line, not only on the expanded row', () => {
    // `recordCheck` validates the anchor against ANCHOR_IDS, so an injected one
    // is only reachable through the rehydration path.
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
    const checkLine = lines.find((line) => line.includes('anchors'))

    expect(checkLine).not.toContain(`${esc}[32m`)
    // Paired presence: the anchor is still named, so a signer can still see
    // which anchor the row came from.
    expect(checkLine).toContain('A-CI')
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

    const verdict = renderCheckLedger(ledger).at(-1) ?? ''

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

    const verdict = renderCheckLedger(ledger).at(-1) ?? ''

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

    const verdict =
      renderCheckLedger(ledger, { triageProfile: 'subtractive' }).at(-1) ?? ''

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
    const banner = lines.findIndex((line) => line.includes(NO_ENDPOINT))
    const firstRow = lines.findIndex((line) => line.includes('UNVERIFIED'))

    expect(banner).toBeGreaterThan(-1)
    expect(banner).toBeLessThan(firstRow)
    expect(lines[banner]).toContain('2 unverified results')
    // The advice the old report gave ten times over, contradicted once.
    expect(lines[banner]).toContain('will not change the answer')
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
