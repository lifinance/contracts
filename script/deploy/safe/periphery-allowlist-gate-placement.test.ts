/** Pins gate W's position in `confirm-safe-tx.ts` by source order, since that CLI signs and cannot be spawned from a test. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  beforeAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const CONFIRM_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'confirm-safe-tx.ts'
)

const GATE = 'if (!peripheryAllowlist.cleared) {'
const GATE_H = 'if (!targetState.cleared) {'
const EVALUATION = 'peripheryAllowlist = await evaluatePeripheryAllowlist('
const ACKNOWLEDGEMENT_RECORDED =
  'recordAcknowledgement(acknowledgementLedger, {'
const ACTION_PROMPT = "consola.prompt('Select action:'"

const IRREVERSIBLE_CALLS = [
  'await signTransaction(safeTransaction)',
  'await signTransaction(signedTx, deployerSafe)',
  'await executeTransaction(',
]

describe('gate W placement in confirm-safe-tx', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(CONFIRM_SCRIPT, 'utf8')
  })

  it('skips the proposal as blocked rather than proceeding', () => {
    const at = source.indexOf(GATE)
    expect(at).toBeGreaterThan(-1)
    const end = source.indexOf('\n    }', at)
    expect(end).toBeGreaterThan(at)
    const block = source.slice(at, end)
    expect(block).toContain('renderPeripheryAllowlistRefusal(')
    expect(block).toContain('recordProposalOutcome({ blocked: true })')
    expect(block).toContain('continue')
    expect(block).not.toContain('signTransaction')
  })

  it('is evaluated before the checks are graded and the prompt is drawn', () => {
    const evaluated = source.indexOf(EVALUATION)
    expect(evaluated).toBeGreaterThan(-1)
    expect(evaluated).toBeLessThan(source.indexOf('proposalCheckResults({'))
    expect(evaluated).toBeLessThan(source.indexOf(ACTION_PROMPT))
  })

  it('hands the ledger the verdict the refusal acts on', () => {
    const at = source.indexOf('proposalCheckResults({')
    expect(at).toBeGreaterThan(-1)
    const end = source.indexOf('\n    })', at)
    expect(end).toBeGreaterThan(at)
    const call = source.slice(at, end)
    expect(call).toContain('peripheryAllowlist,')
  })

  it('prints its findings under the row, once', () => {
    expect(source).toContain(
      'renderPeripheryAllowlistLines(peripheryAllowlist)'
    )
    expect(source.split('renderPeripheryAllowlistLines(').length - 1).toBe(1)
  })

  it('sits after gate H, which it must not swallow', () => {
    expect(source.indexOf(GATE_H)).toBeGreaterThan(-1)
    expect(source.indexOf(GATE)).toBeGreaterThan(source.indexOf(GATE_H))
  })

  it('sits before the acknowledgement is recorded', () => {
    expect(source.indexOf(GATE)).toBeLessThan(
      source.indexOf(ACKNOWLEDGEMENT_RECORDED)
    )
  })

  it('grades against config/global.json at origin/main, not the static import', () => {
    const at = source.indexOf(EVALUATION)
    const end = source.indexOf('\n    } catch', at)
    expect(end).toBeGreaterThan(at)
    const call = source.slice(at, end)
    expect(call).toContain('...peripheryConfigAtPinnedRef(')
    expect(call).toContain('readPinnedBlob(PERIPHERY_CONFIG_REPO_PATH)')
    expect(source).not.toContain('peripheryFunctionsFromConfig(')
    expect(source).not.toContain('peripheryNetworksFromConfig(')
    expect(call).not.toMatch(/peripheryFunctions\s*[:,]/u)
  })

  it('sits before every signing and execution call site', () => {
    for (const call of IRREVERSIBLE_CALLS) {
      const at = source.indexOf(call)
      expect(at).toBeGreaterThan(-1)
      expect(source.indexOf(GATE)).toBeLessThan(at)
    }
  })
})
