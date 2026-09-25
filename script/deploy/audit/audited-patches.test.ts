/**
 * Tests for reading audited fork patches as their upstream source. Everything
 * runs against in-memory readers.
 */

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import type { IAuditLogFile } from './audit-log-guard'
import {
  parseAuditedPatches,
  resolveAuditedPatches,
  withAuditedPatches,
  type AuditedPatches,
  type IPatchSubstitution,
} from './audited-patches'
import {
  collectSourceClosure,
  computeClosureDetail,
  hashAuditRelevantSource,
  type ISourceReader,
} from './source-closure'

const LIB = 'src/Libraries/LibAsset.sol'
const SWAP = 'src/Libraries/LibSwap.sol'
const FACET = 'src/Facets/FooFacet.sol'
const UPSTREAM_SHA = 'a'.repeat(40)
const HEAD = 'HEAD'

const libSource = (
  version: string,
  body: string,
  imports = ['./LibSwap.sol']
) =>
  [
    `/// @custom:version ${version}`,
    ...imports.map((path) => `import "${path}";`),
    `library LibAsset { ${body} }`,
  ].join('\n')

const UPSTREAM_LIB = libSource('2.1.3', 'function t() internal {}')
const PATCHED_LIB = libSource(
  '2.1.3-tron',
  'function t() internal { if (tron) return; }'
)
const FACET_SOURCE = 'import "../Libraries/LibAsset.sol";\ncontract FooFacet {}'
const SWAP_SOURCE = 'library LibSwap {}'

const log: IAuditLogFile = {
  audits: {
    tronAudit: { auditCommitHash: 'b'.repeat(40) },
    upstreamAudit: { auditCommitHash: 'c'.repeat(40) },
  },
  auditedContracts: {
    LibAsset: { '2.1.3': ['upstreamAudit'], '2.1.3-tron': ['tronAudit'] },
  },
}

const declaration = (overrides: Record<string, unknown> = {}) => ({
  [LIB]: {
    patchedSourceHash: hashAuditRelevantSource(PATCHED_LIB),
    upstreamCommit: UPSTREAM_SHA,
    auditId: 'tronAudit',
    ...overrides,
  },
})

const patches: AuditedPatches = parseAuditedPatches(declaration(), log)

const makeReader = (files: Record<string, string>): ISourceReader => ({
  readFile: (path) => files[path],
  readSubmodulePointer: (path) => (path === 'lib/solady' ? 'c' : undefined),
})

const readAtFrom =
  (trees: Record<string, Record<string, string>>) =>
  (treeish: string, path: string): string | undefined =>
    trees[treeish]?.[path]

const resolveWithHead = (head: string | undefined, declared = patches) =>
  resolveAuditedPatches(
    declared,
    log,
    HEAD,
    readAtFrom({
      [HEAD]: head === undefined ? {} : { [LIB]: head },
      [UPSTREAM_SHA]: { [LIB]: UPSTREAM_LIB },
    })
  )

describe('parseAuditedPatches', () => {
  it('accepts a well-formed declaration', () => {
    expect(patches[LIB]?.auditId).toBe('tronAudit')
  })

  it('lower-cases the hash and commit, since source hashes always are', () => {
    const hash = hashAuditRelevantSource(PATCHED_LIB)
    const parsed = parseAuditedPatches(
      declaration({
        patchedSourceHash: `0x${hash.slice(2).toUpperCase()}`,
        upstreamCommit: 'A'.repeat(40),
      }),
      log
    )

    expect(parsed[LIB]?.patchedSourceHash).toBe(hash)
    expect(parsed[LIB]?.upstreamCommit).toBe(UPSTREAM_SHA)
  })

  it.each([
    ['a non-object', [], 'expected an object keyed by patched file path'],
    ['a non-.sol path', { 'README.md': declaration()[LIB] }, 'only .sol files'],
    ['a non-object entry', { [LIB]: 'x' }, 'expected an object'],
    [
      'a malformed hash',
      declaration({ patchedSourceHash: '0x12' }),
      'patchedSourceHash must be a 32-byte hex hash',
    ],
    [
      'a short commit',
      declaration({ upstreamCommit: 'abc' }),
      'upstreamCommit must be a full commit SHA',
    ],
    [
      'an audit missing from the log',
      declaration({ auditId: 'nope' }),
      "auditId 'nope' is not in the log",
    ],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseAuditedPatches(raw, log)).toThrow(message)
  })
})

describe('resolveAuditedPatches', () => {
  it('reports a declaration PR head matches as applied', () => {
    const resolved = resolveWithHead(PATCHED_LIB)

    expect(resolved.substitutions.get(LIB)?.upstreamSource).toBe(UPSTREAM_LIB)
    expect(resolved.applied).toHaveLength(1)
    expect(resolved.mismatched).toEqual([])
  })

  it('ignores comment-only differences, as the closure hash does', () => {
    expect(resolveWithHead(`// note\n${PATCHED_LIB}`).applied).toHaveLength(1)
  })

  it('reports a changed patch with its head hash, and keeps the substitution for audit commits', () => {
    const changed = `${PATCHED_LIB}\nuint x;`
    const resolved = resolveWithHead(changed)

    expect(resolved.applied).toEqual([])
    expect(resolved.mismatched[0]).toContain(hashAuditRelevantSource(changed))
    expect(resolved.substitutions.has(LIB)).toBe(true)
  })

  it('reports a patch absent at PR head', () => {
    expect(resolveWithHead(undefined).mismatched[0]).toContain('(absent)')
  })

  it('throws when the upstream source cannot be read', () => {
    expect(() =>
      resolveAuditedPatches(
        patches,
        log,
        HEAD,
        readAtFrom({ [HEAD]: { [LIB]: PATCHED_LIB } })
      )
    ).toThrow(`upstream source at ${UPSTREAM_SHA} could not be read`)
  })

  it("throws when the audit is listed for another version, not the patch's own", () => {
    const citesUpstream = parseAuditedPatches(
      declaration({ auditId: 'upstreamAudit' }),
      log
    )

    expect(() => resolveWithHead(PATCHED_LIB, citesUpstream)).toThrow(
      "audit 'upstreamAudit' is not listed for LibAsset@2.1.3-tron"
    )
  })

  it('throws when the patch has no readable version', () => {
    const untagged = PATCHED_LIB.replace('/// @custom:version 2.1.3-tron\n', '')
    const declared = parseAuditedPatches(
      declaration({ patchedSourceHash: hashAuditRelevantSource(untagged) }),
      log
    )

    expect(() => resolveWithHead(untagged, declared)).toThrow(
      'LibAsset@(no readable version)'
    )
  })

  it('throws when the patch imports a file upstream does not', () => {
    const withHelper = libSource('2.1.3-tron', 'function t() internal {}', [
      './LibSwap.sol',
      './TronHelper.sol',
    ])
    const declared = parseAuditedPatches(
      declaration({ patchedSourceHash: hashAuditRelevantSource(withHelper) }),
      log
    )

    expect(() => resolveWithHead(withHelper, declared)).toThrow(
      'the patch imports ./TronHelper.sol, which upstream does not'
    )
  })

  it('accepts a patch that drops one of upstream’s imports', () => {
    const fewer = libSource('2.1.3-tron', 'function t() internal {}', [])
    const declared = parseAuditedPatches(
      declaration({ patchedSourceHash: hashAuditRelevantSource(fewer) }),
      log
    )

    expect(resolveWithHead(fewer, declared).applied).toHaveLength(1)
  })
})

describe('withAuditedPatches', () => {
  const substitutions = new Map<string, IPatchSubstitution>([
    [
      LIB,
      {
        patchedSourceHash: hashAuditRelevantSource(PATCHED_LIB),
        upstreamSource: UPSTREAM_LIB,
      },
    ],
  ])
  const tree = (lib: string) =>
    makeReader({ [FACET]: FACET_SOURCE, [LIB]: lib, [SWAP]: SWAP_SOURCE })
  const detailOf = (reader: ISourceReader) =>
    computeClosureDetail(collectSourceClosure(FACET, reader, []), reader)

  it('gives an importer the same closure it had upstream', () => {
    const patched = withAuditedPatches(tree(PATCHED_LIB), substitutions, FACET)

    expect(detailOf(patched)).toEqual(detailOf(tree(UPSTREAM_LIB)))
    expect(patched.readSubmodulePointer('lib/solady')).toBe('c')
  })

  it('reads an upstream commit as-is, since it does not hold the patch', () => {
    const upstream = tree(UPSTREAM_LIB)

    expect(
      withAuditedPatches(upstream, substitutions, FACET).readFile(LIB)
    ).toBe(UPSTREAM_LIB)
  })

  it('reads a changed patch as-is, so the importer drifts', () => {
    const changed = `${PATCHED_LIB}\nuint x;`

    expect(
      withAuditedPatches(tree(changed), substitutions, FACET).readFile(LIB)
    ).toBe(changed)
  })

  it('reads a declared patch as-is when it is the contract being checked', () => {
    const reader = withAuditedPatches(tree(PATCHED_LIB), substitutions, LIB)

    expect(reader.readFile(LIB)).toBe(PATCHED_LIB)
  })

  it('reads an absent file as absent', () => {
    const reader = withAuditedPatches(makeReader({}), substitutions, FACET)

    expect(reader.readFile(LIB)).toBeUndefined()
  })

  it('returns the reader unchanged when nothing is declared', () => {
    const reader = tree(PATCHED_LIB)

    expect(withAuditedPatches(reader, new Map(), FACET)).toBe(reader)
  })
})
