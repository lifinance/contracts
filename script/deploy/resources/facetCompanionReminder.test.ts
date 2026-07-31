import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { isValidNetworkName, readDeployLog } from '../shared/deployLog'
import type { TFacetPeripheryCouplings } from '../shared/facetPeripheryCouplings'

import { buildCompanionReminder } from './facetCompanionReminder'

const COUPLINGS: TFacetPeripheryCouplings = {
  AcrossFacetV4: {
    requiresAnyOf: ['ReceiverAcrossV4', 'ReceiverAcrossV3'],
  },
  AcrossFacetPackedV4: {
    requiresAnyOf: ['ReceiverAcrossV4', 'ReceiverAcrossV3'],
  },
  ChainflipFacet: {
    requiresAnyOf: ['ReceiverChainflip'],
    notRequiredOn: { somechain: 'source-only there' },
  },
}

describe('buildCompanionReminder', () => {
  it('reminds when no companion is in the deploy log', () => {
    const reminder = buildCompanionReminder(
      'AcrossFacetV4',
      'robinhood',
      { LiFiDiamond: '0xdiamond' },
      COUPLINGS
    )

    expect(reminder).toContain('AcrossFacetV4')
    expect(reminder).toContain('robinhood')
    expect(reminder).toContain('ReceiverAcrossV4 or ReceiverAcrossV3')
  })

  it('stays silent when one of the alternative companions is deployed', () => {
    const reminder = buildCompanionReminder(
      'AcrossFacetV4',
      'linea',
      { ReceiverAcrossV3: '0xreceiver' },
      COUPLINGS
    )

    expect(reminder).toBeNull()
  })

  it('treats an empty-string deploy-log entry as not deployed', () => {
    const reminder = buildCompanionReminder(
      'AcrossFacetV4',
      'robinhood',
      { ReceiverAcrossV4: '' },
      COUPLINGS
    )

    expect(reminder).toContain('none is in the deploy log')
  })

  it('stays silent for a contract with no declared coupling', () => {
    expect(
      buildCompanionReminder('GenericSwapFacetV3', 'mainnet', {}, COUPLINGS)
    ).toBeNull()
  })

  it('stays silent for a facet carved out on this network', () => {
    expect(
      buildCompanionReminder('ChainflipFacet', 'somechain', {}, COUPLINGS)
    ).toBeNull()
  })

  it('still reminds for a carved-out facet on other networks', () => {
    expect(
      buildCompanionReminder('ChainflipFacet', 'mainnet', {}, COUPLINGS)
    ).toContain('ReceiverChainflip')
  })

  it('also covers the packed variant of a facet family', () => {
    expect(
      buildCompanionReminder('AcrossFacetPackedV4', 'robinhood', {}, COUPLINGS)
    ).toContain('AcrossFacetPackedV4')
  })

  it('falls back to the real registry when no override is passed', () => {
    expect(buildCompanionReminder('AcrossFacetV4', 'robinhood', {})).toContain(
      'ReceiverAcrossV4'
    )
  })
})

describe('readDeployLog', () => {
  it('reads production addresses for a real network', () => {
    const log = readDeployLog('mainnet', 'production', process.cwd())

    expect(log['LiFiDiamond']).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('reads the staging log for a staging deploy', () => {
    const log = readDeployLog('mainnet', 'staging', process.cwd())

    expect(log['LiFiDiamond']).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('drops empty-string entries so they never count as deployed', () => {
    const log = readDeployLog('mainnet', 'production', process.cwd())

    expect(Object.values(log)).not.toContain('')
  })

  it('refuses a network name that could traverse out of deployments/', () => {
    expect(isValidNetworkName('../../.env')).toBe(false)
    expect(isValidNetworkName('mainnet/../secret')).toBe(false)
    expect(isValidNetworkName('bsc-testnet')).toBe(true)
    expect(isValidNetworkName('mainnet')).toBe(true)
    expect(readDeployLog('../../.env', 'production', process.cwd())).toEqual({})
  })

  it('returns an empty map for a network with no deploy log', () => {
    expect(
      readDeployLog('networkthatdoesnotexist', 'production', process.cwd())
    ).toEqual({})
  })

  it('returns an empty map when the log is not valid JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'companion-reminder-'))
    mkdirSync(join(root, 'deployments'))
    writeFileSync(join(root, 'deployments', 'broken.json'), '{ not json')

    expect(readDeployLog('broken', 'production', root)).toEqual({})
  })

  it('returns an empty map when the log is valid JSON but not an object', () => {
    const root = mkdtempSync(join(tmpdir(), 'companion-reminder-'))
    mkdirSync(join(root, 'deployments'))
    writeFileSync(join(root, 'deployments', 'scalar.json'), 'null')

    expect(readDeployLog('scalar', 'production', root)).toEqual({})
  })

  it('drops non-string entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'companion-reminder-'))
    mkdirSync(join(root, 'deployments'))
    writeFileSync(
      join(root, 'deployments', 'mixed.json'),
      JSON.stringify({ LiFiDiamond: '0xabc', SomeCount: 7, Nested: {} })
    )

    expect(readDeployLog('mixed', 'production', root)).toEqual({
      LiFiDiamond: '0xabc',
    })
  })
})

describe('CLI smoke test', () => {
  // deploySingleContract.sh runs this CLI behind `2>/dev/null || true`, so a crash (bad import,
  // syntax error) would silently disable the reminder forever. Spawning the real entry point
  // proves it executes and prints for a known-missing companion.
  const cliPath = join(import.meta.dir, 'facetCompanionReminder.ts')

  it('exits 0 and prints the reminder when the companion is missing from the log', () => {
    const root = mkdtempSync(join(tmpdir(), 'companion-cli-'))
    mkdirSync(join(root, 'deployments'))
    writeFileSync(join(root, 'deployments', 'smokenet.json'), '{}')

    const result = Bun.spawnSync(
      [process.execPath, cliPath, 'AcrossFacetV4', 'smokenet', 'production'],
      { cwd: root }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('AcrossFacetV4')
    expect(result.stdout.toString()).toContain('ReceiverAcrossV4')
  })

  it('exits 0 and prints nothing without arguments', () => {
    const result = Bun.spawnSync([process.execPath, cliPath])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe('')
  })
})
