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

/**
 * Writes a throwaway project root holding just a deployment cache.
 * @param label - suffix for the temp directory name
 * @param records - cache contents, in the flat shape the real file uses
 * @returns The root directory, for the caller to remove
 */
const writeCache = (label: string, records: unknown[]): string => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `facet-version-utils-${label}-`)
  )
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true })
  fs.writeFileSync(
    path.join(root, '.cache', 'deployments_production.json'),
    JSON.stringify(records)
  )
  return root
}

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
    // The suite-wide fixture deliberately records two different contract names
    // at FACET_ADDRESS, which this resolver reports as a contradiction, so the
    // plain-resolution cases get a root of their own.
    let soleRoot: string

    beforeAll(() => {
      soleRoot = writeCache('sole', [
        {
          contractName: 'AcrossFacetV3',
          network: 'optimism',
          version: '1.1.0',
          address: FACET_ADDRESS,
        },
      ])
    })

    afterAll(() => {
      fs.rmSync(soleRoot, { recursive: true, force: true })
    })

    it('resolves name and version from the deployment record', () => {
      expect(
        resolveDeployedContractByAddress('optimism', [FACET_ADDRESS], soleRoot)
      ).toEqual({
        kind: 'resolved',
        contractName: 'AcrossFacetV3',
        version: '1.1.0',
      })
    })

    it('matches case-insensitively', () => {
      expect(
        resolveDeployedContractByAddress(
          'Optimism',
          [FACET_ADDRESS.toLowerCase()],
          soleRoot
        )
      ).toEqual({
        kind: 'resolved',
        contractName: 'AcrossFacetV3',
        version: '1.1.0',
      })
    })

    it('reports the suite fixture two names at one address as a contradiction', () => {
      expect(
        resolveDeployedContractByAddress('optimism', [FACET_ADDRESS], rootDir)
      ).toEqual({
        kind: 'ambiguous',
        contractNames: ['AcrossFacetV3', 'BrokenEntriesFacet'],
        versions: ['1.1.0'],
      })
    })

    it('reports nothing recorded for an address recorded only on another network', () => {
      expect(
        resolveDeployedContractByAddress('base', [FACET_ADDRESS], soleRoot)
      ).toEqual({ kind: 'unrecorded' })
    })

    it('reports a name contradiction a blank-version sibling would otherwise hide', () => {
      const root = writeCache('blank-masks-name', [
        {
          contractName: 'AcrossFacetV4',
          network: 'base',
          version: '1.0.0',
          address: FACET_ADDRESS,
        },
        {
          contractName: 'SomethingElse',
          network: 'base',
          version: '',
          address: FACET_ADDRESS,
        },
      ])
      try {
        expect(
          resolveDeployedContractByAddress('base', [FACET_ADDRESS], root)
        ).toEqual({
          kind: 'ambiguous',
          contractNames: ['AcrossFacetV4', 'SomethingElse'],
          versions: ['1.0.0'],
        })
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('reports nothing recorded for an unrecorded address', () => {
      expect(
        resolveDeployedContractByAddress(
          'optimism',
          ['0x00000000000000000000000000000000000000ff'],
          rootDir
        )
      ).toEqual({ kind: 'unrecorded' })
    })

    it('reports nothing recorded when no candidate is a usable string', () => {
      expect(
        resolveDeployedContractByAddress('optimism', ['', ''], rootDir)
      ).toEqual({ kind: 'unrecorded' })
    })

    it('reports nothing recorded when the cache is absent', () => {
      expect(
        resolveDeployedContractByAddress(
          'optimism',
          [FACET_ADDRESS],
          path.join(rootDir, 'does-not-exist')
        )
      ).toEqual({ kind: 'unrecorded' })
    })

    it('reports a null version when the record carries none', () => {
      const partialRoot = writeCache('partial', [
        {
          contractName: 'NoVersionFacet',
          network: 'optimism',
          address: FACET_ADDRESS,
        },
      ])
      try {
        expect(
          resolveDeployedContractByAddress(
            'optimism',
            [FACET_ADDRESS],
            partialRoot
          )
        ).toEqual({
          kind: 'resolved',
          contractName: 'NoVersionFacet',
          version: null,
        })
      } finally {
        fs.rmSync(partialRoot, { recursive: true, force: true })
      }
    })

    it('reports a null contract name when the record carries none', () => {
      const namelessRoot = writeCache('nameless', [
        { network: 'optimism', version: '9.9.9', address: FACET_ADDRESS },
      ])
      try {
        expect(
          resolveDeployedContractByAddress(
            'optimism',
            [FACET_ADDRESS],
            namelessRoot
          )
        ).toEqual({
          kind: 'resolved',
          contractName: null,
          version: '9.9.9',
        })
      } finally {
        fs.rmSync(namelessRoot, { recursive: true, force: true })
      }
    })

    // The live production mirror carries six (network, address) pairs with more
    // than one record. These four fixtures are those real shapes.
    it('reports a contradiction when two records give the same address different versions', () => {
      const root = writeCache('dup-version', [
        {
          contractName: 'AllBridgeFacet',
          network: 'tron',
          version: '2.1.1',
          address: 'TCYAJzpLJJGYUqPoq9kVM1zJw9zdmXLUFu',
        },
        {
          contractName: 'AllBridgeFacet',
          network: 'tron',
          version: '2.1.2',
          address: 'TCYAJzpLJJGYUqPoq9kVM1zJw9zdmXLUFu',
        },
      ])
      try {
        expect(
          resolveDeployedContractByAddress(
            'tron',
            ['TCYAJzpLJJGYUqPoq9kVM1zJw9zdmXLUFu'],
            root
          )
        ).toEqual({
          kind: 'ambiguous',
          contractNames: ['AllBridgeFacet'],
          versions: ['2.1.1', '2.1.2'],
        })
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('reports a contradiction when two records give the same address different names', () => {
      const root = writeCache('dup-name', [
        {
          contractName: 'LiFuelFeeCollector',
          network: 'metis',
          version: '1.0.1',
          address: FACET_ADDRESS,
        },
        {
          contractName: 'TokenWrapper',
          network: 'metis',
          version: '1.0.1',
          address: FACET_ADDRESS,
        },
      ])
      try {
        expect(
          resolveDeployedContractByAddress('metis', [FACET_ADDRESS], root)
        ).toEqual({
          kind: 'ambiguous',
          contractNames: ['LiFuelFeeCollector', 'TokenWrapper'],
          versions: ['1.0.1'],
        })
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('resolves past a blank-version sibling, which contradicts nothing', () => {
      const root = writeCache('blank-sibling', [
        {
          contractName: 'PolymerCCTPFacet',
          network: 'base',
          version: '2.0.0',
          address: FACET_ADDRESS,
        },
        {
          contractName: 'PolymerCCTPFacet',
          network: 'base',
          version: '',
          address: FACET_ADDRESS,
        },
      ])
      try {
        expect(
          resolveDeployedContractByAddress('base', [FACET_ADDRESS], root)
        ).toEqual({
          kind: 'resolved',
          contractName: 'PolymerCCTPFacet',
          version: '2.0.0',
        })
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('resolves past a blank-version sibling listed first', () => {
      const root = writeCache('blank-first', [
        {
          contractName: 'PolymerCCTPFacet',
          network: 'base',
          version: '',
          address: FACET_ADDRESS,
        },
        {
          contractName: 'PolymerCCTPFacet',
          network: 'base',
          version: '2.0.0',
          address: FACET_ADDRESS,
        },
      ])
      try {
        expect(
          resolveDeployedContractByAddress('base', [FACET_ADDRESS], root)
        ).toEqual({
          kind: 'resolved',
          contractName: 'PolymerCCTPFacet',
          version: '2.0.0',
        })
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
