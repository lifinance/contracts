import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// eslint-disable-next-line import/no-unresolved
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import {
  getDeployedFacetVersionFromLog,
  resolveDeployedContractByAddress,
} from './facet-version-utils'

const FACET_ADDRESS = '0xC21a00A346d5b29955449CA912343a3aB4C5552f'
const OTHER_ADDRESS = '0x0000000000000000000000000000000000000001'

describe('facet-version-utils', () => {
  let rootDir: string

  beforeAll(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'facet-version-utils-'))
    fs.mkdirSync(path.join(rootDir, '.cache'), { recursive: true })

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

    it('does not memoize a transient parse failure — a later valid read succeeds', () => {
      const flakyRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'facet-version-utils-flaky-')
      )
      const cachePath = path.join(
        flakyRoot,
        '.cache',
        'deployments_production.json'
      )
      try {
        fs.mkdirSync(path.join(flakyRoot, '.cache'), { recursive: true })
        // First read hits a partially-written file (parse throws → catch path).
        fs.writeFileSync(cachePath, '{ broken')
        expect(
          getDeployedFacetVersionFromLog(
            'AcrossFacetV3',
            'optimism',
            [FACET_ADDRESS],
            flakyRoot
          )
        ).toBeNull()

        // The transient failure must not be memoized: once the file is whole,
        // the next call resolves the version rather than staying disabled.
        fs.writeFileSync(
          cachePath,
          JSON.stringify([
            {
              contractName: 'AcrossFacetV3',
              network: 'optimism',
              version: '2.0.0',
              address: FACET_ADDRESS,
            },
          ])
        )
        expect(
          getDeployedFacetVersionFromLog(
            'AcrossFacetV3',
            'optimism',
            [FACET_ADDRESS],
            flakyRoot
          )
        ).toBe('2.0.0')
      } finally {
        fs.rmSync(flakyRoot, { recursive: true, force: true })
      }
    })
  })

  describe('resolveDeployedContractByAddress', () => {
    it('resolves name and version from the deployment record', () => {
      expect(
        resolveDeployedContractByAddress('optimism', [FACET_ADDRESS], rootDir)
      ).toEqual({ contractName: 'AcrossFacetV3', version: '1.1.0' })
    })

    it('matches case-insensitively', () => {
      expect(
        resolveDeployedContractByAddress(
          'Optimism',
          [FACET_ADDRESS.toLowerCase()],
          rootDir
        )
      ).toEqual({ contractName: 'AcrossFacetV3', version: '1.1.0' })
    })

    it('returns null for an address on another network', () => {
      expect(
        resolveDeployedContractByAddress('base', [FACET_ADDRESS], rootDir)
      ).toBeNull()
    })

    it('returns null for an unrecorded address', () => {
      expect(
        resolveDeployedContractByAddress(
          'optimism',
          ['0x00000000000000000000000000000000000000ff'],
          rootDir
        )
      ).toBeNull()
    })

    it('returns null when no candidate is a usable string', () => {
      expect(
        resolveDeployedContractByAddress('optimism', ['', ''], rootDir)
      ).toBeNull()
    })

    it('returns null when the cache is absent', () => {
      expect(
        resolveDeployedContractByAddress(
          'optimism',
          [FACET_ADDRESS],
          path.join(rootDir, 'does-not-exist')
        )
      ).toBeNull()
    })

    it('reports a null version when the record carries none', () => {
      const partialRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'facet-version-utils-partial-')
      )
      try {
        fs.mkdirSync(path.join(partialRoot, '.cache'), { recursive: true })
        fs.writeFileSync(
          path.join(partialRoot, '.cache', 'deployments_production.json'),
          JSON.stringify([
            {
              contractName: 'NoVersionFacet',
              network: 'optimism',
              address: FACET_ADDRESS,
            },
          ])
        )
        expect(
          resolveDeployedContractByAddress(
            'optimism',
            [FACET_ADDRESS],
            partialRoot
          )
        ).toEqual({ contractName: 'NoVersionFacet', version: null })
      } finally {
        fs.rmSync(partialRoot, { recursive: true, force: true })
      }
    })

    it('reports a null contract name when the record carries none', () => {
      const namelessRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'facet-version-utils-nameless-')
      )
      try {
        fs.mkdirSync(path.join(namelessRoot, '.cache'), { recursive: true })
        fs.writeFileSync(
          path.join(namelessRoot, '.cache', 'deployments_production.json'),
          JSON.stringify([
            { network: 'optimism', version: '9.9.9', address: FACET_ADDRESS },
          ])
        )
        expect(
          resolveDeployedContractByAddress(
            'optimism',
            [FACET_ADDRESS],
            namelessRoot
          )
        ).toEqual({ contractName: null, version: '9.9.9' })
      } finally {
        fs.rmSync(namelessRoot, { recursive: true, force: true })
      }
    })
  })
})
