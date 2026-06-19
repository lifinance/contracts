import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// eslint-disable-next-line import/no-unresolved
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import {
  getDeployedFacetVersionFromLog,
  getTargetStateFacetVersion,
} from './facet-version-utils'

const FACET_ADDRESS = '0xC21a00A346d5b29955449CA912343a3aB4C5552f'
const OTHER_ADDRESS = '0x0000000000000000000000000000000000000001'

describe('facet-version-utils', () => {
  let rootDir: string

  beforeAll(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'facet-version-utils-'))
    fs.mkdirSync(path.join(rootDir, '.cache'), { recursive: true })
    fs.mkdirSync(path.join(rootDir, 'script', 'deploy'), { recursive: true })

    // Flat array matching the structure of .cache/deployments_production.json.
    // The cache contains only production records — staging entries are absent.
    fs.writeFileSync(
      path.join(rootDir, '.cache', 'deployments_production.json'),
      JSON.stringify([
        {
          contractName: 'AcrossFacetV3',
          network: 'optimism',
          version: '1.0.0',
          address: OTHER_ADDRESS,
        },
        {
          contractName: 'AcrossFacetV3',
          network: 'optimism',
          version: '1.1.0',
          address: FACET_ADDRESS,
        },
        // BrokenEntriesFacet: one entry with no address (simulates a corrupt record), one valid
        {
          contractName: 'BrokenEntriesFacet',
          network: 'optimism',
          version: '1.0.0',
        },
        {
          contractName: 'BrokenEntriesFacet',
          network: 'optimism',
          version: '1.1.0',
          address: FACET_ADDRESS,
        },
      ])
    )

    fs.writeFileSync(
      path.join(rootDir, 'script', 'deploy', '_targetState.json'),
      JSON.stringify({
        optimism: {
          production: {
            LiFiDiamond: {
              AcrossFacetV3: '1.1.0',
              BadValueFacet: 42,
            },
          },
        },
      })
    )
  })

  afterAll(() => {
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  describe('getDeployedFacetVersionFromLog', () => {
    it('resolves the version for a matching address', () => {
      expect(
        getDeployedFacetVersionFromLog(
          'AcrossFacetV3',
          'optimism',
          [FACET_ADDRESS],
          rootDir
        )
      ).toBe('1.1.0')
    })

    it('matches addresses case-insensitively', () => {
      expect(
        getDeployedFacetVersionFromLog(
          'AcrossFacetV3',
          'optimism',
          [FACET_ADDRESS.toLowerCase()],
          rootDir
        )
      ).toBe('1.1.0')
    })

    it('matches any of the provided address candidates', () => {
      expect(
        getDeployedFacetVersionFromLog(
          'AcrossFacetV3',
          'optimism',
          ['not-an-address', FACET_ADDRESS],
          rootDir
        )
      ).toBe('1.1.0')
    })

    it('only considers production deployments', () => {
      expect(
        getDeployedFacetVersionFromLog(
          'AcrossFacetV3',
          'optimism',
          ['0x92f1a2Db76a8d874563d7641253b65f8b9c1822E'],
          rootDir
        )
      ).toBeNull()
    })

    it('returns null when the address is not in the log', () => {
      expect(
        getDeployedFacetVersionFromLog(
          'AcrossFacetV3',
          'optimism',
          ['0x000000000000000000000000000000000000dEaD'],
          rootDir
        )
      ).toBeNull()
    })

    it('falls back to an address-based scan for an unknown contract name', () => {
      expect(
        getDeployedFacetVersionFromLog(
          'UnknownFacet',
          'optimism',
          [FACET_ADDRESS],
          rootDir
        )
      ).toBe('1.1.0')
    })

    it('resolves via address-based scan when no contract name is given', () => {
      expect(
        getDeployedFacetVersionFromLog(
          null,
          'optimism',
          [OTHER_ADDRESS],
          rootDir
        )
      ).toBe('1.0.0')
    })

    it('returns null for an unknown network', () => {
      expect(
        getDeployedFacetVersionFromLog(
          'AcrossFacetV3',
          'base',
          [FACET_ADDRESS],
          rootDir
        )
      ).toBeNull()
    })

    it('returns null when no address candidates are provided', () => {
      expect(
        getDeployedFacetVersionFromLog('AcrossFacetV3', 'optimism', [], rootDir)
      ).toBeNull()

      expect(
        getDeployedFacetVersionFromLog(
          'AcrossFacetV3',
          'optimism',
          [''],
          rootDir
        )
      ).toBeNull()
    })

    it('skips malformed version entries but matches valid ones', () => {
      expect(
        getDeployedFacetVersionFromLog(
          'BrokenEntriesFacet',
          'optimism',
          [FACET_ADDRESS],
          rootDir
        )
      ).toBe('1.1.0')
    })

    it('returns null when the log file does not exist', () => {
      expect(
        getDeployedFacetVersionFromLog(
          'AcrossFacetV3',
          'optimism',
          [FACET_ADDRESS],
          path.join(rootDir, 'does-not-exist')
        )
      ).toBeNull()
    })

    it('returns null when the log file contains invalid JSON', () => {
      const brokenRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'facet-version-utils-broken-')
      )
      try {
        fs.mkdirSync(path.join(brokenRoot, '.cache'), { recursive: true })
        fs.writeFileSync(
          path.join(brokenRoot, '.cache', 'deployments_production.json'),
          'not json'
        )
        expect(
          getDeployedFacetVersionFromLog(
            'AcrossFacetV3',
            'optimism',
            [FACET_ADDRESS],
            brokenRoot
          )
        ).toBeNull()
      } finally {
        fs.rmSync(brokenRoot, { recursive: true, force: true })
      }
    })

    it('returns null when the cache file is not an array', () => {
      const scalarRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'facet-version-utils-scalar-')
      )
      try {
        fs.mkdirSync(path.join(scalarRoot, '.cache'), { recursive: true })
        fs.writeFileSync(
          path.join(scalarRoot, '.cache', 'deployments_production.json'),
          'null'
        )
        expect(
          getDeployedFacetVersionFromLog(
            'AcrossFacetV3',
            'optimism',
            [FACET_ADDRESS],
            scalarRoot
          )
        ).toBeNull()
      } finally {
        fs.rmSync(scalarRoot, { recursive: true, force: true })
      }
    })
  })

  describe('getTargetStateFacetVersion', () => {
    it('resolves the target version for a known facet', () => {
      expect(
        getTargetStateFacetVersion('optimism', 'AcrossFacetV3', rootDir)
      ).toBe('1.1.0')
    })

    it('lowercases the network key', () => {
      expect(
        getTargetStateFacetVersion('Optimism', 'AcrossFacetV3', rootDir)
      ).toBe('1.1.0')
    })

    it('returns null for a facet missing from the target state', () => {
      expect(
        getTargetStateFacetVersion('optimism', 'UnknownFacet', rootDir)
      ).toBeNull()
    })

    it('returns null for an unknown network', () => {
      expect(
        getTargetStateFacetVersion('base', 'AcrossFacetV3', rootDir)
      ).toBeNull()
    })

    it('returns null when the stored value is not a string', () => {
      expect(
        getTargetStateFacetVersion('optimism', 'BadValueFacet', rootDir)
      ).toBeNull()
    })

    it('returns null when the target state file does not exist', () => {
      expect(
        getTargetStateFacetVersion(
          'optimism',
          'AcrossFacetV3',
          path.join(rootDir, 'does-not-exist')
        )
      ).toBeNull()
    })

    it('returns null when the target state file contains invalid JSON', () => {
      const brokenRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'facet-version-utils-broken-ts-')
      )
      try {
        fs.mkdirSync(path.join(brokenRoot, 'script', 'deploy'), {
          recursive: true,
        })
        fs.writeFileSync(
          path.join(brokenRoot, 'script', 'deploy', '_targetState.json'),
          'not json'
        )
        expect(
          getTargetStateFacetVersion('optimism', 'AcrossFacetV3', brokenRoot)
        ).toBeNull()
      } finally {
        fs.rmSync(brokenRoot, { recursive: true, force: true })
      }
    })

    it('returns null when the target state file is not an object', () => {
      const scalarRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'facet-version-utils-scalar-ts-')
      )
      try {
        fs.mkdirSync(path.join(scalarRoot, 'script', 'deploy'), {
          recursive: true,
        })
        fs.writeFileSync(
          path.join(scalarRoot, 'script', 'deploy', '_targetState.json'),
          'null'
        )
        expect(
          getTargetStateFacetVersion('optimism', 'AcrossFacetV3', scalarRoot)
        ).toBeNull()
      } finally {
        fs.rmSync(scalarRoot, { recursive: true, force: true })
      }
    })
  })
})
