/**
 * Tests for role-name resolution and role-change display in safe-decode-utils.
 * Covers getRoleName (hash -> OZ AccessControl role name) and formatRoleChange
 * (the grantRole / revokeRole / renounceRole display path).
 */
import {
  describe,
  expect,
  it,
  afterEach,
  spyOn,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { consola } from 'consola'

import { getRoleName, formatRoleChange } from './safe-decode-utils'

const DEFAULT_ADMIN_ROLE = `0x${'00'.repeat(32)}`
// OpenZeppelin AccessControl role hashes (public, keccak256 of role names) —
// not private keys, despite matching the 64-hex-char shape.
const CANCELLER_ROLE =
  '0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783' // pre-commit-checker: not a secret
const PROPOSER_ROLE =
  '0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1' // pre-commit-checker: not a secret
const EXECUTOR_ROLE =
  '0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63' // pre-commit-checker: not a secret
const TIMELOCK_ADMIN_ROLE =
  '0x5f58e3a2316349923ce3780f8d587db2d72378aed66a8261c916544fa6846ca5' // pre-commit-checker: not a secret

describe('getRoleName', () => {
  it('resolves known OpenZeppelin role hashes', () => {
    expect(getRoleName(CANCELLER_ROLE)).toBe('CANCELLER_ROLE')
    expect(getRoleName(PROPOSER_ROLE)).toBe('PROPOSER_ROLE')
    expect(getRoleName(EXECUTOR_ROLE)).toBe('EXECUTOR_ROLE')
    expect(getRoleName(TIMELOCK_ADMIN_ROLE)).toBe('TIMELOCK_ADMIN_ROLE')
  })

  it('resolves DEFAULT_ADMIN_ROLE (bytes32 zero, not a keccak hash)', () => {
    expect(getRoleName(DEFAULT_ADMIN_ROLE)).toBe('DEFAULT_ADMIN_ROLE')
  })

  it('is case-insensitive on the hex digits', () => {
    const upperHex = `0x${CANCELLER_ROLE.slice(2).toUpperCase()}`
    expect(getRoleName(upperHex)).toBe('CANCELLER_ROLE')
  })

  it('accepts a hash without the 0x prefix', () => {
    expect(getRoleName(CANCELLER_ROLE.slice(2))).toBe('CANCELLER_ROLE')
  })

  it('returns empty string for an unknown role hash', () => {
    expect(getRoleName(`0x${'11'.repeat(32)}`)).toBe('')
  })
})

describe('formatRoleChange', () => {
  afterEach(() => {
    spyOn(consola, 'info').mockRestore()
  })

  // Output is ANSI-colored, but the function name and the "(ROLE_NAME)" label
  // are each emitted as contiguous substrings, so we assert on the raw joined
  // output without stripping escape codes.
  const capture = async (
    functionName: string,
    role: string,
    account: string
  ): Promise<string> => {
    const infoSpy = spyOn(consola, 'info').mockImplementation(
      (() => {}) as never
    )
    await formatRoleChange(functionName, [role, account], 'mainnet')
    return infoSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  const account = '0xb05E63458A51731Aad26BdcD6E12246330E6095F'
  const ROLE_LABEL = /\([A-Z_]+_ROLE\)/

  it('labels the role on revokeRole (the previously unlabeled path)', async () => {
    const output = await capture('revokeRole', CANCELLER_ROLE, account)
    expect(output).toContain('Function:')
    expect(output).toContain('revokeRole')
    expect(output).toContain(CANCELLER_ROLE)
    expect(output).toContain('(CANCELLER_ROLE)')
  })

  it('labels the role on renounceRole', async () => {
    const output = await capture('renounceRole', PROPOSER_ROLE, account)
    expect(output).toContain('renounceRole')
    expect(output).toContain('(PROPOSER_ROLE)')
  })

  it('still labels the role on grantRole', async () => {
    const output = await capture('grantRole', CANCELLER_ROLE, account)
    expect(output).toContain('grantRole')
    expect(output).toContain('(CANCELLER_ROLE)')
  })

  it('omits the role label for an unknown role hash', async () => {
    const unknown = `0x${'11'.repeat(32)}`
    const output = await capture('revokeRole', unknown, account)
    expect(output).toContain('revokeRole')
    expect(output).toContain(unknown)
    expect(output).not.toMatch(ROLE_LABEL)
  })

  it('returns without logging when args are incomplete', async () => {
    const infoSpy = spyOn(consola, 'info').mockImplementation(
      (() => {}) as never
    )
    await formatRoleChange('revokeRole', [CANCELLER_ROLE], 'mainnet')
    expect(infoSpy).not.toHaveBeenCalled()
  })
})
