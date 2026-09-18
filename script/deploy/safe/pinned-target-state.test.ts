/**
 * Tests for the sign-time target-state check in `pinned-target-state.ts`.
 *
 * The pinned-read tests drive real `git` against a throwaway repository rather
 * than a stub: the property under test is that the anchor comes from
 * `origin/main` and not from the checked-out tree, which a stubbed git cannot
 * demonstrate.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

import committedTargetState from '../_targetState.json'
import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from '../shared/constants'
import { readContractVersion } from '../shared/contract-version'

import type { DeployedContractLookup } from './facet-version-utils'
import {
  blockedByEvaluationError,
  compareSemanticVersions,
  countNetworksDeclaring,
  createPinnedAnchor,
  createPinnedBlobReader,
  createPinnedSourceVersionReader,
  createPinnedTargetStateReader,
  createTargetStateDeps,
  describeTargetStateUnavailable,
  evaluateTargetStateIntent,
  formatTargetStateLines,
  TARGET_STATE_GATE_HEADING,
  PINNED_FETCH_REFSPEC,
  readDeclaredVersion,
  renderTargetStateRefusal,
  resolveExpectedVersion,
  TARGET_STATE_REPO_PATH,
  TARGET_STATE_VERSION_LATEST,
  type IPinnedStateGit,
  type ITargetStateDeps,
  type PinnedTargetState,
  type PinnedTargetStateRead,
} from './pinned-target-state'

/** This repository's root, resolved from this test file. */
const REPO_ROOT_DIR = path.resolve(import.meta.dir, '../../..')

const FACET = '0x1111111111111111111111111111111111111111' as Address
const OTHER_FACET = '0x2222222222222222222222222222222222222222' as Address
const SELECTORS = ['0xaabbccdd'] as Hex[]

const cut = (entries: { facetAddress: Address; action: number }[]): Hex =>
  encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      entries.map((entry) => ({
        facetAddress: entry.facetAddress,
        action: entry.action,
        functionSelectors: SELECTORS,
      })),
      ZERO_ADDRESS as Address,
      '0x' as Hex,
    ],
  })

// `latest` is what a network normally declares; PinnedFacet and WeirdFacet are the
// deliberate exceptions this suite needs.
const STATE: PinnedTargetState = {
  optimism: {
    production: {
      LiFiDiamond: {
        AcrossFacetV3: 'latest',
        PinnedFacet: '1.2.0',
        WeirdFacet: 'v1',
      },
    },
  },
  base: {
    production: { LiFiDiamond: { AcrossFacetV3: 'latest' } },
  },
  arbitrum: {
    production: { LiFiDiamond: { NewFacet: 'latest' } },
  },
  polygon: {
    production: { LiFiDiamond: { NewFacet: 'latest' } },
  },
}

/** What `origin/main`'s source says, for the contracts this suite grades. */
const SOURCE_VERSIONS: Record<string, string> = {
  AcrossFacetV3: '1.2.0',
  NewFacet: '2.0.0',
  PinnedFacet: '2.0.0',
}

const deps = (options: {
  deployed?: { contractName: string | null; version: string | null } | null
  lookup?: DeployedContractLookup
  pinned?: PinnedTargetStateRead
  onRead?: () => void
  sourceVersions?: Record<string, string>
}): ITargetStateDeps => ({
  readPinnedState: () => {
    options.onRead?.()
    return options.pinned ?? { ok: true, state: STATE }
  },
  readSourceVersion: (contractName) => {
    const version = (options.sourceVersions ?? SOURCE_VERSIONS)[contractName]
    return version
      ? { ok: true, version }
      : { ok: false, detail: `no source for ${contractName} at origin/main` }
  },
  resolveDeployed: () =>
    options.lookup ??
    (options.deployed
      ? {
          kind: 'resolved',
          ...options.deployed,
        }
      : { kind: 'unrecorded' }),
})

describe('compareSemanticVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemanticVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareSemanticVersions('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(compareSemanticVersions('1.2.3', '1.2.4')).toBeLessThan(0)
    expect(compareSemanticVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('compares deployment-record build suffixes by their base version', () => {
    expect(compareSemanticVersions('1.2.3-tron', '1.2.3')).toBe(0)
    expect(compareSemanticVersions('1.2.4-zksync', '1.2.3')).toBeGreaterThan(0)
  })

  it('does not compare a version that is not major.minor.patch', () => {
    expect(compareSemanticVersions('1.2', '1.2.0')).toBeNull()
    expect(compareSemanticVersions('1.2.0', 'v1.2.0')).toBeNull()
  })
})

describe('readDeclaredVersion', () => {
  it('reads the production LiFiDiamond entry', () => {
    expect(readDeclaredVersion(STATE, 'optimism', 'PinnedFacet')).toBe('1.2.0')
  })

  it('reads the latest sentinel as written, leaving it for the caller to resolve', () => {
    expect(readDeclaredVersion(STATE, 'optimism', 'AcrossFacetV3')).toBe(
      'latest'
    )
  })

  it('lowercases the network key', () => {
    expect(readDeclaredVersion(STATE, 'Optimism', 'PinnedFacet')).toBe('1.2.0')
  })

  it('returns null for an unknown network or contract', () => {
    expect(readDeclaredVersion(STATE, 'mainnet', 'AcrossFacetV3')).toBeNull()
    expect(readDeclaredVersion(STATE, 'optimism', 'NoSuchFacet')).toBeNull()
  })
})

describe('countNetworksDeclaring', () => {
  it('counts every network declaring that contract', () => {
    expect(countNetworksDeclaring(STATE, 'NewFacet')).toBe(2)
  })

  it('counts zero for a contract nothing declares', () => {
    expect(countNetworksDeclaring(STATE, 'NoSuchFacet')).toBe(0)
  })

  // The count corroborates a first-time add, so it must not depend on the version:
  // every network reads `latest`, and a version-matched count would report 0 fleet-wide.
  it('counts a network that declares the contract as latest', () => {
    expect(countNetworksDeclaring(STATE, 'AcrossFacetV3')).toBe(2)
  })
})

describe('evaluateTargetStateIntent — a network that follows the repo', () => {
  it('clears a newer version', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({ deployed: { contractName: 'AcrossFacetV3', version: '1.3.0' } })
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings[0]?.status).toBe('ahead-of-main')
    expect(verdict.findings[0]?.mainVersion).toBe('1.2.0')
  })

  it('clears the same version', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({ deployed: { contractName: 'AcrossFacetV3', version: '1.2.0' } })
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings[0]?.status).toBe('matches-main')
  })

  it('refuses a downgrade', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({ deployed: { contractName: 'AcrossFacetV3', version: '1.1.0' } })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('downgrade')
    expect(verdict.findings[0]?.detail).toContain('OLDER')
  })

  it('refuses a version pair it cannot order', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 0 }])],
      'base',
      deps({
        deployed: { contractName: 'AcrossFacetV3', version: '1.0' },
        sourceVersions: { AcrossFacetV3: '1.2.0' },
      })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('version-not-comparable')
  })

  // A network following the repo cannot be graded when the repo's own version is
  // unreadable - a deleted or untagged source must refuse, not clear.
  it('refuses when the source version cannot be read at the pinned ref', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'base',
      deps({
        deployed: { contractName: 'AcrossFacetV3', version: '1.2.0' },
        sourceVersions: {},
      })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('expected-version-unresolved')
    expect(verdict.findings[0]?.detail).toContain('no source for AcrossFacetV3')
  })

  it('refuses when the proposed version cannot be resolved at all', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({ deployed: { contractName: 'AcrossFacetV3', version: null } })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('proposed-version-unresolved')
  })
})

describe('evaluateTargetStateIntent — first-time add', () => {
  it('labels an add main does not target and does not block it', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 0 }])],
      'optimism',
      deps({ deployed: { contractName: 'NewFacet', version: '2.0.0' } })
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings[0]?.status).toBe('not-previously-targeted')
    expect(verdict.findings[0]?.crossFleetCount).toBe(2)
  })

  it('does not block a first-time add on a network main knows nothing about', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 0 }])],
      'newchain',
      deps({ deployed: { contractName: 'AcrossFacetV3', version: '1.2.0' } })
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings[0]?.status).toBe('not-previously-targeted')
    expect(verdict.findings[0]?.crossFleetCount).toBe(2)
  })

  // The count is about the contract, not the proposed version, so a record with no
  // version still gets corroboration rather than a blank.
  it('labels a first-time add whose record carries no version, still with a count', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 0 }])],
      'optimism',
      deps({ deployed: { contractName: 'NewFacet', version: null } })
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings[0]?.status).toBe('not-previously-targeted')
    expect(verdict.findings[0]?.crossFleetCount).toBe(2)
  })

  it('refuses an install whose deployment record contradicts itself', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'tron',
      deps({
        lookup: {
          kind: 'ambiguous',
          contractNames: ['AllBridgeFacet'],
          versions: ['2.1.1', '2.1.2'],
        },
      })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('deployment-record-ambiguous')
    expect(verdict.findings[0]?.detail).toContain('2.1.1 / 2.1.2')
  })

  it('refuses an install whose address no deployment record names', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 0 }])],
      'optimism',
      deps({ deployed: null })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('contract-unidentified')
    expect(verdict.findings[0]?.facetAddress).toBe(FACET)
  })
})

describe('evaluateTargetStateIntent — removal and non-cuts', () => {
  it('warns on a removal without blocking, and reads no anchor for it', () => {
    let reads = 0
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: ZERO_ADDRESS as Address, action: 2 }])],
      'optimism',
      deps({ onRead: () => reads++ })
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings[0]?.status).toBe('removal')
    expect(reads).toBe(0)
  })

  it('clears a proposal that carries no diamondCut', () => {
    const transferOwnership = encodeFunctionData({
      abi: parseAbi(['function transferOwnership(address newOwner)']),
      functionName: 'transferOwnership',
      args: [FACET],
    })
    const verdict = evaluateTargetStateIntent(
      [transferOwnership],
      'optimism',
      deps({})
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings).toHaveLength(1)
    expect(verdict.findings[0]?.status).toBe('no-diamond-cut')
  })

  it('clears a proposal with no calls at all', () => {
    const verdict = evaluateTargetStateIntent([], 'optimism', deps({}))
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings[0]?.status).toBe('no-diamond-cut')
  })

  it('refuses a cut action that is not Add, Replace or Remove', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 3 }])],
      'optimism',
      deps({})
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('unrecognised-cut-action')
  })

  it('refuses calldata whose cut cannot be read', () => {
    const hidden = encodeFunctionData({
      abi: parseAbi(['function multiSend(bytes transactions)']),
      functionName: 'multiSend',
      args: [cut([{ facetAddress: FACET, action: 0 }])],
    })
    const verdict = evaluateTargetStateIntent([hidden], 'optimism', deps({}))
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('calldata-not-readable')
  })
})

describe('evaluateTargetStateIntent — the anchor itself', () => {
  it('refuses an install when the pinned state could not be refreshed', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({ pinned: { ok: false, reason: 'fetch-failed' } })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('pinned-state-unavailable')
    expect(verdict.findings[0]?.detail).toContain('could not refresh')
  })

  it('refuses the whole proposal when one element of a batch refuses', () => {
    const versions = new Map<string, DeployedContractLookup>([
      [
        FACET.toLowerCase(),
        {
          kind: 'resolved',
          contractName: 'AcrossFacetV3',
          version: '1.1.0',
        },
      ],
      [
        OTHER_FACET.toLowerCase(),
        {
          kind: 'resolved',
          contractName: 'NewFacet',
          version: '2.0.0',
        },
      ],
    ])
    const verdict = evaluateTargetStateIntent(
      [
        cut([
          { facetAddress: OTHER_FACET, action: 0 },
          { facetAddress: FACET, action: 1 },
        ]),
      ],
      'optimism',
      {
        readPinnedState: () => ({ ok: true, state: STATE }),
        readSourceVersion: (contractName) => {
          const version = SOURCE_VERSIONS[contractName]
          return version
            ? { ok: true, version }
            : { ok: false, detail: `no source for ${contractName}` }
        },
        resolveDeployed: (facetAddress) =>
          versions.get(facetAddress.toLowerCase()) ?? { kind: 'unrecorded' },
      }
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings.map((f) => f.status)).toEqual([
      'not-previously-targeted',
      'downgrade',
    ])
  })
})

describe('resolveExpectedVersion', () => {
  const source = (versions: Record<string, string>) => (name: string) =>
    versions[name]
      ? ({ ok: true, version: versions[name] } as const)
      : ({ ok: false, detail: 'no source' } as const)

  it('reports a contract the network does not declare as absent', () => {
    expect(
      resolveExpectedVersion(STATE, 'optimism', 'NoSuchFacet', source({}))
    ).toEqual({ kind: 'absent' })
  })

  it('returns a declared semver as a pin, without consulting the source', () => {
    let consulted = false
    const expected = resolveExpectedVersion(
      STATE,
      'optimism',
      'PinnedFacet',
      () => {
        consulted = true
        return { ok: false, detail: 'should not be reached' }
      }
    )
    expect(expected).toEqual({ kind: 'pin', version: '1.2.0' })
    expect(consulted).toBe(false)
  })

  it('resolves latest from the source at the pinned ref', () => {
    expect(
      resolveExpectedVersion(
        STATE,
        'optimism',
        'AcrossFacetV3',
        source({ AcrossFacetV3: '9.9.9' })
      )
    ).toEqual({ kind: 'latest', version: '9.9.9' })
  })

  it('reports latest as unresolved when the source cannot be read', () => {
    const expected = resolveExpectedVersion(
      STATE,
      'optimism',
      'AcrossFacetV3',
      source({})
    )
    expect(expected.kind).toBe('unresolved')
  })
})

describe('evaluateTargetStateIntent — a pinned network', () => {
  it('clears a cut installing exactly the pinned version', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({ deployed: { contractName: 'PinnedFacet', version: '1.2.0' } })
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings[0]?.status).toBe('matches-pin')
  })

  it('clears a suffixed deployment record whose base matches the pin', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({
        deployed: { contractName: 'PinnedFacet', version: '1.2.0-tron' },
      })
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings[0]?.status).toBe('matches-pin')
  })

  // A pin says "this version, no other". Newer is still not what it asked for,
  // so it is graded as equality rather than as an ordering.
  it('refuses a cut installing a NEWER version than the pin', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({ deployed: { contractName: 'PinnedFacet', version: '2.0.0' } })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('pinned-mismatch')
    expect(verdict.findings[0]?.mainVersion).toBe('1.2.0')
  })

  it('refuses a cut installing an older version than the pin', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({ deployed: { contractName: 'PinnedFacet', version: '1.1.0' } })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('pinned-mismatch')
  })

  // The repo moving on is exactly the situation a pin exists for, so it must not
  // turn the pin into a pass.
  it('does not clear a pinned network just because the repo agrees with the cut', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({
        deployed: { contractName: 'PinnedFacet', version: '2.0.0' },
        sourceVersions: { PinnedFacet: '2.0.0' },
      })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('pinned-mismatch')
  })

  // The blank is in the deployment record, not in a proposal contradicting the pin,
  // and the remedy differs — so it must not be reported as a pin mismatch.
  it('names a record with no version as unresolved rather than a pin mismatch', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({ deployed: { contractName: 'PinnedFacet', version: null } })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('proposed-version-unresolved')
  })

  it('refuses a pin that is not orderable against the proposed version', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'optimism',
      deps({ deployed: { contractName: 'WeirdFacet', version: '1.0.0' } })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('pinned-mismatch')
  })
})

describe('blockedByEvaluationError', () => {
  it('does not clear', () => {
    const verdict = blockedByEvaluationError('boom')
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.detail).toContain('boom')
  })
})

describe('renderTargetStateRefusal', () => {
  it('names the gate and points at its findings without repeating them', () => {
    const verdict = evaluateTargetStateIntent(
      [
        cut([
          { facetAddress: ZERO_ADDRESS as Address, action: 2 },
          { facetAddress: FACET, action: 1 },
        ]),
      ],
      'optimism',
      deps({ deployed: { contractName: 'AcrossFacetV3', version: '1.1.0' } })
    )
    expect(verdict.cleared).toBe(false)
    const text = renderTargetStateRefusal(verdict).join('\n')
    expect(text).toContain(TARGET_STATE_GATE_HEADING)
    expect(text).toContain('NOT SIGNING')
    expect(text).toContain('1 finding')
    // The detail belongs to the section-2 block, which is where this sends the
    // reader; a second copy here is the same fact twice on one screen.
    expect(text).not.toContain('OLDER')
    expect(text).not.toContain('AcrossFacetV3')
    expect(text).toContain('WHAT WAS CHECKED FOR YOU')
  })
})

describe('formatTargetStateLines', () => {
  it('names the pinned source and puts a refusal before a pass', () => {
    const verdict = evaluateTargetStateIntent(
      [
        cut([
          { facetAddress: ZERO_ADDRESS as Address, action: 2 },
          { facetAddress: FACET, action: 1 },
        ]),
      ],
      'optimism',
      deps({ deployed: { contractName: 'AcrossFacetV3', version: '1.1.0' } })
    )
    const lines = formatTargetStateLines(verdict)
    const at = (text: string): number =>
      lines.findIndex((line) => line.includes(text))

    // Order, not offsets: the block opens on its gate, then says where it read
    // from, then lists findings worst first. Pinned by index it moved every
    // time a line was added above it.
    expect(lines[0]).toBe('')
    expect(at(TARGET_STATE_GATE_HEADING)).toBe(1)
    expect(at(`origin/main:${TARGET_STATE_REPO_PATH}`)).toBe(2)
    expect(at('DOWNGRADE')).toBeLessThan(at('REMOVAL'))
    expect(at('REMOVAL')).toBeGreaterThan(-1)
  })

  // A cut that replaces the selectors already routed and adds the new ones
  // grades one facet through two elements, and both reach the same sentence.
  // Printed twice, a signer reads two facts and looks for the difference.
  it('states one facet at one version once, however many elements install it', () => {
    const verdict = evaluateTargetStateIntent(
      [
        cut([
          { facetAddress: FACET, action: 1 },
          { facetAddress: FACET, action: 0 },
        ]),
      ],
      'optimism',
      deps({ deployed: { contractName: 'AcrossFacetV3', version: '2.0.0' } })
    )
    const named = formatTargetStateLines(verdict).filter((line) =>
      line.includes('AcrossFacetV3')
    )

    expect(verdict.findings).toHaveLength(2)
    expect(named).toHaveLength(1)
  })

  it('prints the cross-fleet count for a first-time add', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 0 }])],
      'optimism',
      deps({ deployed: { contractName: 'NewFacet', version: '2.0.0' } })
    )
    expect(formatTargetStateLines(verdict).join('\n')).toContain(
      '[2 network(s) declare this contract]'
    )
  })

  // A removal returns before the anchor is read, so the block stated where a
  // target state had been read from under a proposal that never read one, over
  // a single line repeating the gate's own stand-down — all of it below the
  // gate rows, under no heading naming the gate it belonged to.
  it('says nothing when no element of the cut was graded against main', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: ZERO_ADDRESS as Address, action: 2 }])],
      'optimism',
      deps({ deployed: { contractName: 'AcrossFacetV3', version: '1.1.0' } })
    )

    expect(verdict.findings.map((f) => f.status)).toEqual(['removal'])
    expect(formatTargetStateLines(verdict)).toEqual([])
  })

  it('says nothing when the proposal carries no cut at all', () => {
    expect(
      formatTargetStateLines(
        evaluateTargetStateIntent([], 'optimism', deps({}))
      )
    ).toEqual([])
  })

  // The paired positive for the two above: a cut that removes one facet and
  // installs another did reach main, so the block prints — and it still lists
  // the removal, which on a mixed cut is a fact the signer has not been told
  // anywhere else.
  it('still lists an ungraded element beside one that was graded', () => {
    const verdict = evaluateTargetStateIntent(
      [
        cut([
          { facetAddress: ZERO_ADDRESS as Address, action: 2 },
          { facetAddress: FACET, action: 0 },
        ]),
      ],
      'optimism',
      deps({ deployed: { contractName: 'NewFacet', version: '2.0.0' } })
    )
    const plain = formatTargetStateLines(verdict).join('\n')

    expect(plain).toContain('REMOVAL')
    expect(plain).toContain(`origin/main:${TARGET_STATE_REPO_PATH}`)
  })
})

// The suites above grade synthetic fixtures, which stay green no matter what the
// committed target state says. These grade the real file: the semantics of
// `_targetState.json` and the gate that reads it are one thing, and a change to
// either that the other cannot handle has to fail here.
describe('the committed target state is gradeable', () => {
  const state = committedTargetState as PinnedTargetState

  const SEMVER_ONLY = /^\d+\.\d+\.\d+$/

  const entries = Object.entries(state).flatMap(([network, environments]) =>
    Object.entries(environments).flatMap(([environment, diamonds]) =>
      Object.entries(diamonds ?? {}).flatMap(([diamond, contracts]) =>
        Object.entries(contracts ?? {}).map(([contract, version]) => ({
          network,
          environment,
          diamond,
          contract,
          version: String(version),
        }))
      )
    )
  )

  it('declares something', () => {
    expect(entries.length).toBeGreaterThan(1000)
  })

  // A value that is neither is exactly what made the gate refuse every proposal:
  // it reaches compareSemanticVersions, fails to order, and blocks.
  it('holds only the latest sentinel or a major.minor.patch pin', () => {
    const bad = entries.filter(
      (entry) =>
        entry.version !== TARGET_STATE_VERSION_LATEST &&
        !SEMVER_ONLY.test(entry.version)
    )
    expect(
      bad.map(
        (e) => `${e.network}/${e.environment}: ${e.contract}=${e.version}`
      )
    ).toEqual([])
  })

  // Deliberately reads the working tree while production reads `origin/main`. The two
  // differ only for a checkout that is behind, and what this asserts is THIS commit's own
  // consistency — a PR deleting a contract's source without dropping its target-state
  // entry is exactly the drift that would make the real gate refuse, and this commit is
  // what becomes `origin/main`. Using the pinned reader here would instead cost a network
  // fetch and ~200 `git show` calls per run.
  it('resolves every production entry to a comparable expected version', () => {
    const readSource = (contractName: string) =>
      workingTreeSourceVersion(contractName)

    const unresolved = entries
      .filter((entry) => entry.environment === 'production')
      .map((entry) => ({
        entry,
        expected: resolveExpectedVersion(
          state,
          entry.network,
          entry.contract,
          readSource
        ),
      }))
      .filter(({ expected }) => expected.kind === 'unresolved')
      .map(({ entry }) => `${entry.network}: ${entry.contract}`)

    expect([...new Set(unresolved)]).toEqual([])
  })
})

// Reads a contract's @custom:version from this checkout. The production reader
// goes through git at the pinned ref; here the working tree is the subject.
const workingTreeSourceVersion = (
  contractName: string
): { ok: true; version: string } | { ok: false; detail: string } => {
  for (const dir of ['src', 'src/Facets', 'src/Periphery', 'src/Security']) {
    const full = path.join(REPO_ROOT_DIR, dir, `${contractName}.sol`)
    if (!fs.existsSync(full)) continue
    const read = readContractVersion(fs.readFileSync(full, 'utf8'))
    return read.kind === 'ok'
      ? { ok: true, version: read.base }
      : {
          ok: false,
          detail: `${dir}/${contractName}.sol has no usable version`,
        }
  }
  return { ok: false, detail: `no source for ${contractName}` }
}

// Only the `latest` path — the committed file carries no pins today, so matches-pin and
// pinned-mismatch are exercised on fixtures above and cannot be proven here.
describe('the gate fires on the committed target state (latest path)', () => {
  const state = committedTargetState as PinnedTargetState
  // A contract the committed file really declares on a real network, resolved
  // from the file rather than named here, so the case cannot rot into a no-op.
  const subject = Object.entries(
    state.mainnet?.production?.LiFiDiamond ?? {}
  ).find(
    ([name]) =>
      name.endsWith('Facet') && workingTreeSourceVersion(name).ok === true
  )

  const realDeps = (proposedVersion: string): ITargetStateDeps => ({
    readPinnedState: () => ({ ok: true, state }),
    readSourceVersion: workingTreeSourceVersion,
    resolveDeployed: () => ({
      kind: 'resolved',
      contractName: subject?.[0] ?? 'unknown',
      version: proposedVersion,
    }),
  })

  it('has a real subject to grade', () => {
    expect(subject).toBeDefined()
  })

  it('clears the version the repo actually carries', () => {
    if (!subject) throw new Error('no subject')
    const source = workingTreeSourceVersion(subject[0])
    if (!source.ok) throw new Error('no source version')
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'mainnet',
      realDeps(source.version)
    )
    expect(verdict.findings[0]?.status).toBe('matches-main')
    expect(verdict.cleared).toBe(true)
  })

  // The falsification: a check that cannot refuse real data is not a check.
  it('refuses a downgrade of that same contract', () => {
    if (!subject) throw new Error('no subject')
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 1 }])],
      'mainnet',
      realDeps('0.0.1')
    )
    expect(verdict.findings[0]?.status).toBe('downgrade')
    expect(verdict.cleared).toBe(false)
  })
})

describe('createPinnedSourceVersionReader', () => {
  let origin: string
  let clone: string

  // stderr ignored for the same reason defaultGit.show ignores it: this suite probes
  // paths that are meant to be absent, and each miss would otherwise print a raw `fatal:`.
  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

  const CANONICAL_REMOTE = 'git@github.com:lifinance/contracts.git'
  const realGit = (cwd: string): IPinnedStateGit => ({
    remoteUrl: () => CANONICAL_REMOTE,
    fetch: () => {
      git(cwd, ['fetch', '--quiet', 'origin', PINNED_FETCH_REFSPEC])
    },
    show: (revSpec) => git(cwd, ['show', revSpec]),
    revParse: (ref) => git(cwd, ['rev-parse', ref]),
  })

  const write = (rel: string, body: string): void => {
    const full = path.join(clone, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }

  const contract = (version: string): string =>
    `// SPDX-License-Identifier: LGPL-3.0-only\npragma solidity ^0.8.17;\n\n/// @title Test\n/// @custom:version ${version}\ncontract Test {}\n`

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-source-'))
    origin = path.join(base, 'origin.git')
    clone = path.join(base, 'clone')

    execFileSync('git', ['init', '--bare', '-b', 'main', origin])
    execFileSync('git', ['clone', origin, clone])
    git(clone, ['config', 'user.email', 'test@example.com'])
    git(clone, ['config', 'user.name', 'test'])
    git(clone, ['config', 'commit.gpgsign', 'false'])

    write('src/Facets/AFacet.sol', contract('1.2.0'))
    write('src/Periphery/APeriphery.sol', contract('3.1.0'))
    write('src/Facets/SuffixFacet.sol', contract('2.1.3-tron'))
    write('src/Facets/UntaggedFacet.sol', 'contract UntaggedFacet {}\n')
    git(clone, ['add', '-A'])
    git(clone, ['commit', '-m', 'sources on main'])
    git(clone, ['push', 'origin', 'main'])
  })

  afterAll(() => {
    fs.rmSync(path.dirname(origin), { recursive: true, force: true })
  })

  const read = () =>
    createPinnedSourceVersionReader({ repoRoot: clone, git: realGit(clone) })

  it('reads a facet version', () => {
    expect(read()('AFacet')).toEqual({ ok: true, version: '1.2.0' })
  })

  it('finds a contract under src/Periphery', () => {
    expect(read()('APeriphery')).toEqual({ ok: true, version: '3.1.0' })
  })

  // Ordering is defined on major.minor.patch, so a suffixed tag grades on its base.
  it('grades a suffixed version on its base', () => {
    expect(read()('SuffixFacet')).toEqual({ ok: true, version: '2.1.3' })
  })

  it('refuses a contract with no source at the pinned ref', () => {
    const result = read()('DeletedFacet')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.detail).toContain('no source for DeletedFacet')
  })

  it('refuses a source that carries no @custom:version', () => {
    const result = read()('UntaggedFacet')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.detail).toContain('carries no @custom:version')
  })

  it('refuses a name that is not a Solidity identifier', () => {
    const result = read()('../../etc/passwd')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.detail).toContain('not a Solidity identifier')
  })

  // The same property the target-state reader has: the anchor is origin/main, so
  // a version the proposer commits on their own branch cannot decide the verdict.
  it('reads from origin/main, not from the checked-out branch', () => {
    git(clone, ['checkout', '-q', '-b', 'proposer-branch'])
    write('src/Facets/AFacet.sol', contract('9.9.9'))
    git(clone, ['add', '-A'])
    git(clone, ['commit', '-q', '-m', 'proposer bumps the version'])

    expect(read()('AFacet')).toEqual({ ok: true, version: '1.2.0' })
    git(clone, ['checkout', '-q', 'main'])
  })

  // One fetch per reader, not one per contract: a proposal naming several facets
  // asks this reader once per name.
  it('fetches once however many contracts it is asked for', () => {
    let fetches = 0
    const counting = createPinnedSourceVersionReader({
      repoRoot: clone,
      git: {
        ...realGit(clone),
        fetch: () => {
          fetches++
          git(clone, ['fetch', '--quiet', 'origin', PINNED_FETCH_REFSPEC])
        },
      },
    })
    counting('AFacet')
    counting('APeriphery')
    counting('SuffixFacet')
    counting('DeletedFacet')
    expect(fetches).toBe(1)
  })

  it('refuses when the remote is not lifinance/contracts', () => {
    const forked = createPinnedSourceVersionReader({
      repoRoot: clone,
      git: {
        ...realGit(clone),
        remoteUrl: () => 'git@github.com:evil/fork.git',
      },
    })
    const result = forked('AFacet')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.detail).toContain('not github.com/lifinance/contracts')
  })
})

// The first attempt at the shared anchor reached only the tests: confirm-safe-tx.ts built
// its own reader and passed it as an override, so createTargetStateDeps anchored the SOURCE
// read to a second, freshly-created anchor — per network, on a fleet run lasting hours.
// These assert the production wiring itself, since a unit test of the factory cannot see it.
describe('the production wiring shares one anchor', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT_DIR, 'script/deploy/safe/confirm-safe-tx.ts'),
    'utf8'
  )

  it('builds one anchor for the whole run', () => {
    expect(source).toContain('const pinnedAnchor = createPinnedAnchor()')
    expect(source).toContain(
      'const readPinnedTargetState = createPinnedTargetStateReader({\n  anchor: pinnedAnchor,\n})'
    )
  })

  // Asserted as one block, not as two separate substrings: `anchor: pinnedAnchor,` also
  // appears where the state reader is built, so a looser check stays green even when the
  // deps call has lost it — which is precisely the bug this is here to catch.
  it('hands that same anchor to the deps, not only the state reader', () => {
    expect(source).toContain(
      `createTargetStateDeps(network, {
          readPinnedState: readPinnedTargetState,
          anchor: pinnedAnchor,
        })`
    )
  })

  // Overriding one reader while the other anchors itself is exactly how the straddle
  // returns, so the option has to exist and be honoured.
  it('createTargetStateDeps honours an injected anchor for the source read', () => {
    let anchorCalls = 0
    const deps = createTargetStateDeps('mainnet', {
      anchor: () => {
        anchorCalls++
        return { ok: false, reason: 'remote-unexpected' }
      },
    })
    deps.readSourceVersion('AnyFacet')
    expect(anchorCalls).toBeGreaterThan(0)
  })
})

describe('the anchor is one commit for both reads', () => {
  let origin: string
  let clone: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

  const write = (dir: string, rel: string, body: string): void => {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }

  const contract = (version: string): string =>
    `/// @custom:version ${version}\ncontract Test {}\n`

  const state = (version: string): string =>
    JSON.stringify({
      optimism: { production: { LiFiDiamond: { AFacet: version } } },
    })

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-anchor-'))
    origin = path.join(base, 'origin.git')
    clone = path.join(base, 'clone')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin])
    execFileSync('git', ['clone', origin, clone])
    git(clone, ['config', 'user.email', 'test@example.com'])
    git(clone, ['config', 'user.name', 'test'])
    git(clone, ['config', 'commit.gpgsign', 'false'])

    write(clone, TARGET_STATE_REPO_PATH, state('latest'))
    write(clone, 'src/Facets/AFacet.sol', contract('1.0.0'))
    git(clone, ['add', '-A'])
    git(clone, ['commit', '-m', 'first snapshot'])
    git(clone, ['push', 'origin', 'main'])
  })

  afterAll(() => {
    fs.rmSync(path.dirname(origin), { recursive: true, force: true })
  })

  // The race CodeRabbit flagged: two readers each resolving origin/main can straddle a
  // merge and combine an old target state with a new source version — a pairing that
  // never existed on main. A shared anchor pins both reads to one commit, so a push
  // landing mid-evaluation cannot be half-seen.
  it('does not see a merge that lands between the two reads', () => {
    const seam: IPinnedStateGit = {
      remoteUrl: () => 'git@github.com:lifinance/contracts.git',
      fetch: () => {
        git(clone, ['fetch', '--quiet', 'origin', PINNED_FETCH_REFSPEC])
      },
      show: (revSpec) => git(clone, ['show', revSpec]),
      revParse: (ref) => git(clone, ['rev-parse', ref]),
    }
    const anchor = createPinnedAnchor({ repoRoot: clone, git: seam })
    const readState = createPinnedTargetStateReader({
      repoRoot: clone,
      git: seam,
      anchor,
    })
    const readSource = createPinnedSourceVersionReader({
      repoRoot: clone,
      git: seam,
      anchor,
    })

    // First read establishes the anchor.
    const before = readState()
    expect(before.ok).toBe(true)

    // A merge lands on main between the two reads.
    const author = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-anchor-push-'))
    execFileSync('git', ['clone', origin, author], { stdio: 'ignore' })
    git(author, ['config', 'user.email', 'other@example.com'])
    git(author, ['config', 'user.name', 'other'])
    git(author, ['config', 'commit.gpgsign', 'false'])
    write(author, 'src/Facets/AFacet.sol', contract('2.0.0'))
    git(author, ['add', '-A'])
    git(author, ['commit', '-m', 'bump on main'])
    git(author, ['push', 'origin', 'main'])
    // Move this clone's own refs/remotes/origin/main forward too. Without it the test
    // cannot tell a stored SHA from a stored ref name — the ref would still resolve to
    // the old commit and the assertion would hold for the wrong reason.
    seam.fetch()

    // The source read must still see the commit the anchor pinned, not the new tip.
    expect(readSource('AFacet')).toEqual({ ok: true, version: '1.0.0' })
    fs.rmSync(author, { recursive: true, force: true })
  })
})

describe('createPinnedTargetStateReader', () => {
  let origin: string
  let clone: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' })

  const targetStateAt = (dir: string): string =>
    path.join(dir, TARGET_STATE_REPO_PATH)

  // The clone's real origin is a temp path, so the remote read is the one seam
  // the assertion cannot check against a fixture; git itself does the rest.
  const CANONICAL_REMOTE = 'git@github.com:lifinance/contracts.git'
  const realGit = (cwd: string): IPinnedStateGit => ({
    remoteUrl: () => CANONICAL_REMOTE,
    fetch: () => {
      git(cwd, ['fetch', '--quiet', 'origin', PINNED_FETCH_REFSPEC])
    },
    show: (revSpec) => git(cwd, ['show', revSpec]),
    revParse: (ref) => git(cwd, ['rev-parse', ref]),
  })

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-target-state-'))
    origin = path.join(base, 'origin.git')
    clone = path.join(base, 'clone')

    execFileSync('git', ['init', '--bare', '-b', 'main', origin])
    execFileSync('git', ['clone', origin, clone])
    git(clone, ['config', 'user.email', 'test@example.com'])
    git(clone, ['config', 'user.name', 'test'])
    git(clone, ['config', 'commit.gpgsign', 'false'])

    fs.mkdirSync(path.dirname(targetStateAt(clone)), { recursive: true })
    fs.writeFileSync(
      targetStateAt(clone),
      JSON.stringify({
        optimism: { production: { LiFiDiamond: { AcrossFacetV3: '1.2.0' } } },
      })
    )
    git(clone, ['add', '-A'])
    git(clone, ['commit', '-m', 'target state on main'])
    git(clone, ['push', 'origin', 'main'])
  })

  afterAll(() => {
    fs.rmSync(path.dirname(origin), { recursive: true, force: true })
  })

  it('reads the anchor from origin/main, not from the checked-out branch', () => {
    const onMain = createPinnedTargetStateReader({
      repoRoot: clone,
      git: realGit(clone),
    })()
    expect(onMain.ok).toBe(true)

    // The proposer's own branch, committed and checked out — the shape that used
    // to decide the verdict.
    git(clone, ['checkout', '-b', 'proposer-branch'])
    fs.writeFileSync(
      targetStateAt(clone),
      JSON.stringify({
        optimism: { production: { LiFiDiamond: { AcrossFacetV3: '9.9.9' } } },
      })
    )
    git(clone, ['add', '-A'])
    git(clone, ['commit', '-m', 'proposer edits the anchor'])

    const onBranch = createPinnedTargetStateReader({
      repoRoot: clone,
      git: realGit(clone),
    })()
    expect(onBranch.ok).toBe(true)
    if (!onBranch.ok || !onMain.ok) throw new Error('expected a readable state')

    expect(
      readDeclaredVersion(onBranch.state, 'optimism', 'AcrossFacetV3')
    ).toBe('1.2.0')
    expect(
      JSON.parse(fs.readFileSync(targetStateAt(clone), 'utf8')).optimism
        .production.LiFiDiamond.AcrossFacetV3
    ).toBe('9.9.9')
    expect(onBranch.state).toEqual(onMain.state)
  })

  it('reads once per process', () => {
    let shows = 0
    const reader = createPinnedTargetStateReader({
      repoRoot: clone,
      git: {
        remoteUrl: () => CANONICAL_REMOTE,
        fetch: () => undefined,
        show: (revSpec) => {
          shows++
          return git(clone, ['show', revSpec])
        },
        revParse: (ref) => git(clone, ['rev-parse', ref]),
      },
    })
    reader()
    reader()
    expect(shows).toBe(1)
  })

  // A rev-parse failure is NOT a network fault — the fetch already succeeded — so it gets
  // its own reason and remedy, and it is memoized: retrying a condition the clone cannot
  // resolve would re-fetch once per network per contract on a fleet run.
  it('reports an unresolvable revision distinctly, and only resolves it once', () => {
    let fetches = 0
    const anchor = createPinnedAnchor({
      repoRoot: clone,
      git: {
        remoteUrl: () => CANONICAL_REMOTE,
        fetch: () => {
          fetches++
        },
        revParse: () => {
          throw new Error('bad ref')
        },
        show: () => {
          throw new Error('must not be reached')
        },
      },
    })

    for (let call = 0; call < 5; call++)
      expect(anchor()).toEqual({ ok: false, reason: 'revision-unresolvable' })
    expect(fetches).toBe(1)
    expect(describeTargetStateUnavailable('revision-unresolvable')).toContain(
      'rather than the network'
    )
  })

  it('reports a failed fetch rather than reading a stale local ref', () => {
    const read = createPinnedTargetStateReader({
      repoRoot: clone,
      git: {
        remoteUrl: () => CANONICAL_REMOTE,
        fetch: () => {
          throw new Error('no route to host')
        },
        revParse: () => {
          throw new Error('must not be reached')
        },
        show: () => {
          throw new Error('must not be reached')
        },
      },
    })()
    expect(read).toEqual({ ok: false, reason: 'fetch-failed' })
  })

  it('retries a failed fetch instead of pinning the refusal for the process', () => {
    let fetches = 0
    const reader = createPinnedTargetStateReader({
      repoRoot: clone,
      git: {
        remoteUrl: () => CANONICAL_REMOTE,
        fetch: () => {
          fetches++
          if (fetches === 1) throw new Error('no route to host')
        },
        show: (revSpec) => git(clone, ['show', revSpec]),
        revParse: (ref) => git(clone, ['rev-parse', ref]),
      },
    })
    expect(reader()).toEqual({ ok: false, reason: 'fetch-failed' })
    expect(reader().ok).toBe(true)
    expect(fetches).toBe(2)
  })

  it('reports an unreadable blob', () => {
    const read = createPinnedTargetStateReader({
      repoRoot: clone,
      git: {
        remoteUrl: () => CANONICAL_REMOTE,
        fetch: () => undefined,
        show: () => {
          throw new Error('does not exist in origin/main')
        },
        revParse: (ref) => git(clone, ['rev-parse', ref]),
      },
    })()
    expect(read).toEqual({ ok: false, reason: 'blob-unreadable' })
  })

  it('refuses an anchor read through a remote that is not the canonical repo', () => {
    for (const url of [
      'git@github.com:0xDEnYO/contracts.git',
      'https://github.com/lifinance/contracts-tron.git',
      origin,
    ])
      expect(
        createPinnedTargetStateReader({
          repoRoot: clone,
          git: {
            remoteUrl: () => url,
            fetch: () => {
              throw new Error('must not be reached')
            },
            revParse: () => {
              throw new Error('must not be reached')
            },
            show: () => {
              throw new Error('must not be reached')
            },
          },
        })()
      ).toEqual({ ok: false, reason: 'remote-unexpected' })
  })

  // The repository is the right one; the transport is not. A fetch over cleartext
  // is the attacker's to rewrite, and the anchor SHA comes from that same fetch,
  // so nothing downstream can tell the difference.
  it('refuses the canonical repo over cleartext http', () => {
    for (const url of [
      'http://github.com/lifinance/contracts.git',
      'http://github.com/lifinance/contracts',
      'http://git@github.com:80/lifinance/contracts.git',
    ])
      expect(
        createPinnedTargetStateReader({
          repoRoot: clone,
          git: {
            remoteUrl: () => url,
            fetch: () => {
              throw new Error('must not be reached')
            },
            revParse: () => {
              throw new Error('must not be reached')
            },
            show: () => {
              throw new Error('must not be reached')
            },
          },
        })()
      ).toEqual({ ok: false, reason: 'remote-unexpected' })

    // The repository named in the refusal is the one the signer already has, so
    // the remedy is actionable only where it names the transport too.
    const remedy = describeTargetStateUnavailable('remote-unexpected')
    expect(remedy).toContain('https')
    expect(remedy).toContain('SSH')
  })

  it('reports a remote it could not read as unreadable, not as the wrong remote', () => {
    let reads = 0
    const reader = createPinnedTargetStateReader({
      repoRoot: clone,
      git: {
        ...realGit(clone),
        remoteUrl: () => {
          reads++
          if (reads === 1) throw new Error('git: fork failed')
          return CANONICAL_REMOTE
        },
      },
    })
    const read = reader()
    expect(read).toEqual({ ok: false, reason: 'remote-unreadable' })
    if (read.ok) throw new Error('expected a refusal')
    expect(describeTargetStateUnavailable(read.reason)).toContain(
      "could not read this clone's"
    )
    expect(reader().ok).toBe(true)
  })

  it('names the wrong remote rather than a missing one', () => {
    const read = createPinnedTargetStateReader({
      repoRoot: clone,
      git: { ...realGit(clone), remoteUrl: () => 'git@github.com:evil/x.git' },
    })()
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('expected a refusal')
    expect(describeTargetStateUnavailable(read.reason)).toContain(
      'github.com/lifinance/contracts'
    )
  })

  // A clone the proposer supplied can carry a tag named `origin/main`, and git
  // resolves tags before remote-tracking refs.
  it('reads the remote-tracking ref, not a same-named tag in the clone', () => {
    git(clone, ['checkout', 'main'])
    const shadow = path.join(clone, 'shadow.json')
    fs.writeFileSync(shadow, 'shadow')
    const blob = git(clone, ['hash-object', '-w', shadow]).trim()
    fs.rmSync(shadow)
    const tree = execFileSync('git', ['mktree'], {
      cwd: clone,
      encoding: 'utf8',
      input: `100644 blob ${blob}\t${path.basename(TARGET_STATE_REPO_PATH)}\n`,
    }).trim()
    const shadowCommit = git(clone, [
      'commit-tree',
      tree,
      '-m',
      'a ref the proposer controls',
    ]).trim()
    git(clone, ['tag', '-f', 'origin/main', shadowCommit])

    try {
      const read = createPinnedTargetStateReader({
        repoRoot: clone,
        git: realGit(clone),
      })()
      expect(read.ok).toBe(true)
      if (!read.ok) throw new Error('expected a readable state')
      expect(readDeclaredVersion(read.state, 'optimism', 'AcrossFacetV3')).toBe(
        '1.2.0'
      )
    } finally {
      git(clone, ['tag', '-d', 'origin/main'])
    }
  })

  it('accepts every spelling of the canonical remote', () => {
    for (const url of [
      'git@github.com:lifinance/contracts.git',
      'https://github.com/lifinance/contracts.git',
      'https://github.com/lifinance/contracts\n',
      'ssh://git@github.com/lifinance/contracts.git',
      'ssh://git@ssh.github.com:443/lifinance/contracts.git',
    ])
      expect(
        createPinnedTargetStateReader({
          repoRoot: clone,
          git: { ...realGit(clone), remoteUrl: () => url },
        })().ok
      ).toBe(true)
  })

  // Falsifies the refspec rather than asserting the argv: in a clone with no
  // fetch refspec of its own, `git fetch origin main` leaves origin/main where
  // it was, so the anchor would be read stale with no error.
  it('updates origin/main even where the clone has no fetch refspec', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-refspec-'))
    try {
      const ownOrigin = path.join(base, 'origin.git')
      const author = path.join(base, 'author')
      const stale = path.join(base, 'stale')
      execFileSync('git', ['init', '--bare', '-b', 'main', ownOrigin])
      execFileSync('git', ['clone', ownOrigin, author])
      git(author, ['config', 'user.email', 'test@example.com'])
      git(author, ['config', 'user.name', 'test'])
      git(author, ['config', 'commit.gpgsign', 'false'])
      fs.mkdirSync(path.dirname(targetStateAt(author)), { recursive: true })
      fs.writeFileSync(
        targetStateAt(author),
        JSON.stringify({
          optimism: { production: { LiFiDiamond: { AcrossFacetV3: '1.2.0' } } },
        })
      )
      git(author, ['add', '-A'])
      git(author, ['commit', '-m', 'target state on main'])
      git(author, ['push', 'origin', 'main'])

      execFileSync('git', ['clone', ownOrigin, stale])
      git(stale, ['config', '--unset', 'remote.origin.fetch'])
      const before = git(stale, ['rev-parse', 'origin/main']).trim()

      fs.writeFileSync(
        targetStateAt(author),
        JSON.stringify({
          optimism: { production: { LiFiDiamond: { AcrossFacetV3: '1.3.0' } } },
        })
      )
      git(author, ['add', '-A'])
      git(author, ['commit', '-m', 'move main on'])
      git(author, ['push', 'origin', 'main'])

      git(stale, ['fetch', '--quiet', 'origin', 'main'])
      expect(git(stale, ['rev-parse', 'origin/main']).trim()).toBe(before)

      const read = createPinnedTargetStateReader({
        repoRoot: stale,
        git: realGit(stale),
      })()
      expect(read.ok).toBe(true)
      if (!read.ok) throw new Error('expected a readable state')
      expect(readDeclaredVersion(read.state, 'optimism', 'AcrossFacetV3')).toBe(
        '1.3.0'
      )
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('reports content that is not a target-state object', () => {
    for (const raw of ['not json', 'null', '[]'])
      expect(
        createPinnedTargetStateReader({
          repoRoot: clone,
          git: {
            remoteUrl: () => CANONICAL_REMOTE,
            fetch: () => undefined,
            show: () => raw,
            revParse: (ref) => git(clone, ['rev-parse', ref]),
          },
        })()
      ).toEqual({ ok: false, reason: 'invalid-shape' })
  })
})

describe('createTargetStateDeps', () => {
  let cacheRootDir: string

  // The base58 form of FACET. Hard-coded rather than derived, so the assertion
  // cannot move with the conversion it is checking.
  const FACET_BASE58 = 'TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV'

  beforeAll(() => {
    cacheRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'target-state-deps-'))
    fs.mkdirSync(path.join(cacheRootDir, '.cache'), { recursive: true })
    fs.writeFileSync(
      path.join(cacheRootDir, '.cache', 'deployments_production.json'),
      JSON.stringify([
        {
          contractName: 'TronFacet',
          network: 'tron',
          version: '1.4.0',
          address: FACET_BASE58,
        },
        {
          contractName: 'AcrossFacetV3',
          network: 'optimism',
          version: '1.4.0',
          address: FACET,
        },
      ])
    )
  })

  afterAll(() => {
    fs.rmSync(cacheRootDir, { recursive: true, force: true })
  })

  it('resolves a Tron record recorded in base58 from the hex address a cut carries', () => {
    const resolved = createTargetStateDeps('tron', {
      readPinnedState: () => ({ ok: true, state: STATE }),
      cacheRootDir,
    }).resolveDeployed(FACET)
    expect(resolved).toEqual({
      kind: 'resolved',
      contractName: 'TronFacet',
      version: '1.4.0',
    })
  })

  it('does not find that Tron record under the hex address', () => {
    const records = JSON.parse(
      fs.readFileSync(
        path.join(cacheRootDir, '.cache', 'deployments_production.json'),
        'utf8'
      )
    ) as { network: string; address: string }[]
    expect(records.find((r) => r.network === 'tron')?.address).toBe(
      FACET_BASE58
    )
    expect(
      createTargetStateDeps('optimism', {
        readPinnedState: () => ({ ok: true, state: STATE }),
        cacheRootDir,
      }).resolveDeployed(FACET)
    ).toEqual({
      kind: 'resolved',
      contractName: 'AcrossFacetV3',
      version: '1.4.0',
    })
  })
})

describe('createPinnedBlobReader', () => {
  const okGit = (
    blobs: Record<string, string>
  ): { git: IPinnedStateGit; counts: { fetch: number; show: number } } => {
    const counts = { fetch: 0, show: 0 }
    return {
      counts,
      git: {
        remoteUrl: () => 'git@github.com:lifinance/contracts.git',
        fetch: () => {
          counts.fetch += 1
        },
        revParse: () => 'abc1234\n',
        show: (revSpec) => {
          counts.show += 1
          const blob = blobs[revSpec.split(':')[1] ?? '']
          if (blob === undefined) throw new Error('no such path')
          return blob
        },
      },
    }
  }

  it('fetches once however many paths it is asked for', () => {
    const { git, counts } = okGit({
      'a.json': '{"a":1}',
      'b.json': '{"b":2}',
    })
    const read = createPinnedBlobReader({ repoRoot: '/repo', git })

    expect(read('a.json')).toEqual({ ok: true, value: { a: 1 } })
    expect(read('b.json')).toEqual({ ok: true, value: { b: 2 } })
    expect(counts.fetch).toBe(1)
    expect(counts.show).toBe(2)
  })

  it('reads each path once and serves the rest from cache', () => {
    const { git, counts } = okGit({ 'a.json': '{"a":1}' })
    const read = createPinnedBlobReader({ repoRoot: '/repo', git })

    read('a.json')
    read('a.json')
    expect(counts.show).toBe(1)
  })

  it('keeps one unreadable path from condemning another', () => {
    const { git } = okGit({ 'b.json': '{"b":2}' })
    const read = createPinnedBlobReader({ repoRoot: '/repo', git })

    expect(read('missing.json')).toEqual({
      ok: false,
      reason: 'blob-unreadable',
    })
    expect(read('b.json')).toEqual({ ok: true, value: { b: 2 } })
  })

  it('retries a fetch that failed rather than pinning every later read to it', () => {
    let failing = true
    const git: IPinnedStateGit = {
      remoteUrl: () => 'git@github.com:lifinance/contracts.git',
      fetch: () => {
        if (failing) throw new Error('transient')
      },
      revParse: () => 'abc1234\n',
      show: () => '{"a":1}',
    }
    const read = createPinnedBlobReader({ repoRoot: '/repo', git })

    expect(read('a.json')).toEqual({ ok: false, reason: 'fetch-failed' })
    failing = false
    expect(read('a.json')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('never fetches from a remote that is not the contracts repo', () => {
    let fetched = 0
    const git: IPinnedStateGit = {
      remoteUrl: () => 'git@github.com:attacker/contracts.git',
      fetch: () => {
        fetched += 1
      },
      revParse: () => 'abc1234\n',
      show: () => '{"a":1}',
    }
    const read = createPinnedBlobReader({ repoRoot: '/repo', git })

    expect(read('a.json')).toEqual({ ok: false, reason: 'remote-unexpected' })
    expect(read('b.json')).toEqual({ ok: false, reason: 'remote-unexpected' })
    expect(fetched).toBe(0)
  })

  it('refuses a blob that is not a JSON object', () => {
    const { git } = okGit({ 'a.json': '[1,2,3]', 'b.json': 'not json' })
    const read = createPinnedBlobReader({ repoRoot: '/repo', git })

    expect(read('a.json')).toEqual({ ok: false, reason: 'invalid-shape' })
    expect(read('b.json')).toEqual({ ok: false, reason: 'invalid-shape' })
  })
})
