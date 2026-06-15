import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  afterAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { normalizeProposeCalls } from './propose-calls'

const TARGET_A = '0x1111111111111111111111111111111111111111'
const TARGET_B = '0x2222222222222222222222222222222222222222'
const CALLDATA_REMOVE = '0xdeadbeef'
const CALLDATA_ADD = '0xcafebabe'

describe('normalizeProposeCalls', () => {
  it('normalizes a single to/calldata pair', () => {
    const { targets, calldatas } = normalizeProposeCalls({
      to: TARGET_A,
      calldata: CALLDATA_REMOVE,
    })
    expect(targets).toEqual([TARGET_A])
    expect(calldatas).toEqual([CALLDATA_REMOVE])
  })

  it('normalizes multiple pairs with timelock, preserving order', () => {
    const { targets, calldatas } = normalizeProposeCalls({
      to: [TARGET_A, TARGET_B],
      calldata: [CALLDATA_REMOVE, CALLDATA_ADD],
      timelock: true,
    })
    expect(targets).toEqual([TARGET_A, TARGET_B])
    expect(calldatas).toEqual([CALLDATA_REMOVE, CALLDATA_ADD])
  })

  it('rejects multiple pairs without --timelock', () => {
    expect(() =>
      normalizeProposeCalls({
        to: [TARGET_A, TARGET_B],
        calldata: [CALLDATA_REMOVE, CALLDATA_ADD],
      })
    ).toThrow(/require --timelock/)
  })

  it('rejects mismatched to/calldata counts', () => {
    expect(() =>
      normalizeProposeCalls({
        to: [TARGET_A, TARGET_B],
        calldata: [CALLDATA_REMOVE],
        timelock: true,
      })
    ).toThrow(/must match/)
  })

  it('rejects missing calldata and calldataFile', () => {
    expect(() => normalizeProposeCalls({ to: TARGET_A })).toThrow(
      /--calldata or --calldataFile/
    )
  })

  it('rejects an invalid target address', () => {
    expect(() =>
      normalizeProposeCalls({ to: '0xnot-an-address', calldata: '0x' })
    ).toThrow(/not a valid address/)
  })

  it('rejects non-hex calldata (viem would silently zero-pad it)', () => {
    expect(() =>
      normalizeProposeCalls({ to: TARGET_A, calldata: 'deadbeef' as never })
    ).toThrow(/not well-formed hex/)
  })

  it('allows empty calldata (0x) for a single call (nonce-gap filler)', () => {
    const { calldatas } = normalizeProposeCalls({
      to: TARGET_A,
      calldata: '0x',
    })
    expect(calldatas).toEqual(['0x'])
  })

  it('rejects empty calldata (0x) inside a multi-call batch', () => {
    expect(() =>
      normalizeProposeCalls({
        to: [TARGET_A, TARGET_B],
        calldata: [CALLDATA_REMOVE, '0x'],
        timelock: true,
      })
    ).toThrow(/empty payloads are not allowed in multi-call/)
  })

  describe('calldataFile', () => {
    const tmpFile = path.join(os.tmpdir(), `propose-calls-test-${process.pid}`)
    fs.writeFileSync(tmpFile, `${CALLDATA_REMOVE}\n`)
    afterAll(() => fs.rmSync(tmpFile, { force: true }))

    it('loads and trims calldata from file', () => {
      const { calldatas } = normalizeProposeCalls({
        to: TARGET_A,
        calldataFile: tmpFile,
      })
      expect(calldatas).toEqual([CALLDATA_REMOVE])
    })

    it('rejects calldataFile combined with multiple pairs', () => {
      expect(() =>
        normalizeProposeCalls({
          to: [TARGET_A, TARGET_B],
          calldataFile: tmpFile,
          timelock: true,
        })
      ).toThrow(/cannot be combined with multiple/)
    })

    it('rejects a missing calldata file', () => {
      expect(() =>
        normalizeProposeCalls({
          to: TARGET_A,
          calldataFile: `${tmpFile}-does-not-exist`,
        })
      ).toThrow(/Calldata file not found/)
    })

    it('rejects calldata and calldataFile provided together', () => {
      expect(() =>
        normalizeProposeCalls({
          to: TARGET_A,
          calldata: CALLDATA_REMOVE,
          calldataFile: tmpFile,
        })
      ).toThrow(/either --calldata or --calldataFile, not both/)
    })

    it('treats an empty --calldata default as absent alongside calldataFile', () => {
      const { calldatas } = normalizeProposeCalls({
        to: TARGET_A,
        calldata: '' as never,
        calldataFile: tmpFile,
      })
      expect(calldatas).toEqual([CALLDATA_REMOVE])
    })
  })

  // Pins the load-bearing citty contract the CLI relies on: repeated flags must
  // parse to arrays (citty 0.1.x via its mri-style parser). citty 0.2.x keeps
  // only the LAST value — if this test fails after a citty upgrade, the runtime
  // argv guard in propose-to-safe.ts is the only thing preventing a combined
  // proposal from silently dropping inner calls. Do not remove either.
  describe('citty repeated-flag contract', () => {
    it('repeated string flags parse to arrays', async () => {
      // citty does not export its parser publicly, so drive a minimal command
      // through runCommand and observe what the run handler receives
      const { defineCommand, runCommand } = await import('citty')
      let parsedTo: unknown
      const cmd = defineCommand({
        args: { to: { type: 'string' }, calldata: { type: 'string' } },
        run({ args }) {
          parsedTo = args.to
        },
      })
      await runCommand(cmd, {
        rawArgs: [
          '--to',
          TARGET_A,
          '--calldata',
          CALLDATA_REMOVE,
          '--to',
          TARGET_B,
          '--calldata',
          CALLDATA_ADD,
        ],
      })
      expect(Array.isArray(parsedTo)).toBe(true)
      expect(parsedTo).toEqual([TARGET_A, TARGET_B])
    })
  })
})
