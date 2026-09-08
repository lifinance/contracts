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
  title: 'Deployed codehash matches the attested build',
}

const TARGET_STATE: ICheckDefinition = {
  checkId: 'target-state',
  section: 'Intent',
  checkClass: 'semantic',
  title: 'Facet version matches the declared target state',
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

/** The one line naming a network, so an assertion cannot match a summary line. */
const rowFor = (lines: string[], network: string): string => {
  const matches = lines.filter((line) => line.includes(network))
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

  it('names what --triage relaxed instead of dropping it silently', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'fail', actual: '1.0.1' })
    )

    const lines = renderCheckLedger(ledger, { triageProfile: 'subtractive' })
    const row = rowFor(lines, 'mainnet')

    expect(row).toContain('relaxed by --triage')
    expect(lines.at(-1)).toContain('1 relaxed by --triage')
    expect(lines.at(-1)).not.toContain('BLOCKED')
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

    expect(row).toContain('NEEDS REVIEW · relaxed by --triage')
    expect(row).not.toContain('→ review the change')
    expect(lines.at(-1)).toContain('1 relaxed by --triage')
  })

  it('keeps blocking an integrity FAIL under --triage', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))

    const lines = renderCheckLedger(ledger, { triageProfile: 'subtractive' })

    expect(lines.at(-1)).toContain('BLOCKED')
    expect(rowFor(lines, 'mainnet')).not.toContain('relaxed by --triage')
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

  it('opens with a header naming the coverage denominator', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(ledger, result({ network: 'polygon' }))

    expect(renderCheckLedger(ledger)[0]).toContain(
      'Check Ledger — 1 check × 2 networks'
    )
  })
})
