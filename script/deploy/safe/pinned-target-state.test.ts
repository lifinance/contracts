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

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from '../shared/constants'

import type { IDeployedContractIdentity } from './facet-version-utils'
import {
  blockedByEvaluationError,
  compareSemanticVersions,
  countNetworksDeclaring,
  createPinnedTargetStateReader,
  createTargetStateDeps,
  evaluateTargetStateIntent,
  formatTargetStateLines,
  readDeclaredVersion,
  TARGET_STATE_REPO_PATH,
  type ITargetStateDeps,
  type PinnedTargetState,
  type PinnedTargetStateRead,
} from './pinned-target-state'

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

const STATE: PinnedTargetState = {
  optimism: {
    production: {
      LiFiDiamond: { AcrossFacetV3: '1.2.0', WeirdFacet: 'v1' },
    },
  },
  base: {
    production: { LiFiDiamond: { AcrossFacetV3: '1.3.0' } },
  },
  arbitrum: {
    production: { LiFiDiamond: { NewFacet: '2.0.0' } },
  },
  polygon: {
    production: { LiFiDiamond: { NewFacet: '2.0.0' } },
  },
}

const deps = (options: {
  deployed?: IDeployedContractIdentity | null
  pinned?: PinnedTargetStateRead
  onRead?: () => void
}): ITargetStateDeps => ({
  readPinnedState: () => {
    options.onRead?.()
    return options.pinned ?? { ok: true, state: STATE }
  },
  resolveDeployed: () => options.deployed ?? null,
})

describe('compareSemanticVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemanticVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareSemanticVersions('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(compareSemanticVersions('1.2.3', '1.2.4')).toBeLessThan(0)
    expect(compareSemanticVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('does not compare a version that is not major.minor.patch', () => {
    expect(compareSemanticVersions('1.2', '1.2.0')).toBeNull()
    expect(compareSemanticVersions('1.2.0', 'v1.2.0')).toBeNull()
    expect(compareSemanticVersions('1.2.0-rc1', '1.2.0')).toBeNull()
  })
})

describe('readDeclaredVersion', () => {
  it('reads the production LiFiDiamond entry', () => {
    expect(readDeclaredVersion(STATE, 'optimism', 'AcrossFacetV3')).toBe(
      '1.2.0'
    )
  })

  it('lowercases the network key', () => {
    expect(readDeclaredVersion(STATE, 'Optimism', 'AcrossFacetV3')).toBe(
      '1.2.0'
    )
  })

  it('returns null for an unknown network or contract', () => {
    expect(readDeclaredVersion(STATE, 'mainnet', 'AcrossFacetV3')).toBeNull()
    expect(readDeclaredVersion(STATE, 'optimism', 'NoSuchFacet')).toBeNull()
  })
})

describe('countNetworksDeclaring', () => {
  it('counts every network declaring that contract at that version', () => {
    expect(countNetworksDeclaring(STATE, 'NewFacet', '2.0.0')).toBe(2)
  })

  it('counts zero for a version nothing declares', () => {
    expect(countNetworksDeclaring(STATE, 'NewFacet', '3.0.0')).toBe(0)
  })
})

describe('evaluateTargetStateIntent — upgrade of a facet main already targets', () => {
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
      'optimism',
      deps({ deployed: { contractName: 'WeirdFacet', version: '1.0.0' } })
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('version-not-comparable')
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
    expect(verdict.findings[0]?.crossFleetCount).toBe(1)
  })

  it('does not block an add whose address resolves to nothing', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 0 }])],
      'optimism',
      deps({ deployed: null })
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings[0]?.status).toBe('not-previously-targeted')
    expect(verdict.findings[0]?.crossFleetCount).toBeNull()
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
    const versions = new Map<string, IDeployedContractIdentity>([
      [
        FACET.toLowerCase(),
        { contractName: 'AcrossFacetV3', version: '1.1.0' },
      ],
      [
        OTHER_FACET.toLowerCase(),
        { contractName: 'NewFacet', version: '2.0.0' },
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
        resolveDeployed: (facetAddress) =>
          versions.get(facetAddress.toLowerCase()) ?? null,
      }
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings.map((f) => f.status)).toEqual([
      'not-previously-targeted',
      'downgrade',
    ])
  })
})

describe('blockedByEvaluationError', () => {
  it('does not clear', () => {
    const verdict = blockedByEvaluationError('boom')
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.detail).toContain('boom')
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
    expect(lines[0]).toContain(`origin/main:${TARGET_STATE_REPO_PATH}`)
    expect(lines[1]).toContain('DOWNGRADE')
    expect(lines[2]).toContain('REMOVAL')
  })

  it('prints the cross-fleet count for a first-time add', () => {
    const verdict = evaluateTargetStateIntent(
      [cut([{ facetAddress: FACET, action: 0 }])],
      'optimism',
      deps({ deployed: { contractName: 'NewFacet', version: '2.0.0' } })
    )
    expect(formatTargetStateLines(verdict)[1]).toContain(
      '[2 network(s) already declare this contract at this version]'
    )
  })
})

describe('createPinnedTargetStateReader', () => {
  let origin: string
  let clone: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' })

  const targetStateAt = (dir: string): string =>
    path.join(dir, TARGET_STATE_REPO_PATH)

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
    const onMain = createPinnedTargetStateReader({ repoRoot: clone })()
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

    const onBranch = createPinnedTargetStateReader({ repoRoot: clone })()
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
        fetch: () => undefined,
        show: (revSpec) => {
          shows++
          return git(clone, ['show', revSpec])
        },
      },
    })
    reader()
    reader()
    expect(shows).toBe(1)
  })

  it('reports a failed fetch rather than reading a stale local ref', () => {
    const read = createPinnedTargetStateReader({
      repoRoot: clone,
      git: {
        fetch: () => {
          throw new Error('no route to host')
        },
        show: () => {
          throw new Error('must not be reached')
        },
      },
    })()
    expect(read).toEqual({ ok: false, reason: 'fetch-failed' })
  })

  it('reports an unreadable blob', () => {
    const read = createPinnedTargetStateReader({
      repoRoot: clone,
      git: {
        fetch: () => undefined,
        show: () => {
          throw new Error('does not exist in origin/main')
        },
      },
    })()
    expect(read).toEqual({ ok: false, reason: 'blob-unreadable' })
  })

  it('reports content that is not a target-state object', () => {
    for (const raw of ['not json', 'null', '[]'])
      expect(
        createPinnedTargetStateReader({
          repoRoot: clone,
          git: { fetch: () => undefined, show: () => raw },
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
    expect(resolved).toEqual({ contractName: 'TronFacet', version: '1.4.0' })
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
    ).toEqual({ contractName: 'AcrossFacetV3', version: '1.4.0' })
  })
})
