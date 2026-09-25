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
} from './audited-patches'
import {
  collectSourceClosure,
  computeClosureDetail,
  hashAuditRelevantSource,
  type ISourceReader,
} from './source-closure'

const LIB = 'src/Libraries/LibAsset.sol'
const FACET = 'src/Facets/FooFacet.sol'
const UPSTREAM_SHA = 'a'.repeat(40)
const HEAD = 'HEAD'

const UPSTREAM_LIB = 'library LibAsset { function t() internal {} }'
const PATCHED_LIB =
  'library LibAsset { function t() internal { if (tron) return; } }'
const FACET_SOURCE = 'import "../Libraries/LibAsset.sol";\ncontract FooFacet {}'

const log: IAuditLogFile = {
  audits: { tronAudit: { auditCommitHash: 'b'.repeat(40) } },
  auditedContracts: { LibAsset: { '2.1.3-tron': ['tronAudit'] } },
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

describe('parseAuditedPatches', () => {
  it('accepts a declaration whose audit is listed for the contract', () => {
    expect(patches[LIB]?.auditId).toBe('tronAudit')
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

  it('rejects an audit that exists but is not listed for the patched contract', () => {
    const otherLog: IAuditLogFile = {
      ...log,
      auditedContracts: { OtherLib: { '1.0.0': ['tronAudit'] } },
    }

    expect(() => parseAuditedPatches(declaration(), otherLog)).toThrow(
      "audit 'tronAudit' is not listed for LibAsset"
    )
  })
})

describe('resolveAuditedPatches', () => {
  it('substitutes the upstream source when PR head is the declared patch', () => {
    const resolved = resolveAuditedPatches(
      patches,
      HEAD,
      readAtFrom({
        [HEAD]: { [LIB]: PATCHED_LIB },
        [UPSTREAM_SHA]: { [LIB]: UPSTREAM_LIB },
      })
    )

    expect(resolved.substitutions.get(LIB)).toBe(UPSTREAM_LIB)
    expect(resolved.applied).toHaveLength(1)
    expect(resolved.mismatched).toEqual([])
  })

  it('ignores comment-only differences, as the closure hash does', () => {
    const resolved = resolveAuditedPatches(
      patches,
      HEAD,
      readAtFrom({
        [HEAD]: { [LIB]: `// note\n${PATCHED_LIB}` },
        [UPSTREAM_SHA]: { [LIB]: UPSTREAM_LIB },
      })
    )

    expect(resolved.substitutions.has(LIB)).toBe(true)
  })

  it('leaves a changed patch alone and reports its head hash', () => {
    const changed = `${PATCHED_LIB}\nuint x;`
    const resolved = resolveAuditedPatches(
      patches,
      HEAD,
      readAtFrom({
        [HEAD]: { [LIB]: changed },
        [UPSTREAM_SHA]: { [LIB]: UPSTREAM_LIB },
      })
    )

    expect(resolved.substitutions.size).toBe(0)
    expect(resolved.mismatched[0]).toContain(hashAuditRelevantSource(changed))
  })

  it('leaves a patch absent at PR head alone', () => {
    const resolved = resolveAuditedPatches(patches, HEAD, readAtFrom({}))

    expect(resolved.substitutions.size).toBe(0)
    expect(resolved.mismatched[0]).toContain('(absent)')
  })

  it('throws when a matching patch has no readable upstream source', () => {
    expect(() =>
      resolveAuditedPatches(
        patches,
        HEAD,
        readAtFrom({ [HEAD]: { [LIB]: PATCHED_LIB } })
      )
    ).toThrow(`upstream source at ${UPSTREAM_SHA} could not be read`)
  })
})

describe('withAuditedPatches', () => {
  const head = makeReader({ [FACET]: FACET_SOURCE, [LIB]: PATCHED_LIB })
  const substitutions = new Map([[LIB, UPSTREAM_LIB]])

  it('gives an importer the same closure it had upstream', () => {
    const upstream = makeReader({ [FACET]: FACET_SOURCE, [LIB]: UPSTREAM_LIB })
    const patched = withAuditedPatches(head, substitutions, FACET)
    const detailOf = (reader: ISourceReader) =>
      computeClosureDetail(collectSourceClosure(FACET, reader, []), reader)

    expect(detailOf(patched)).toEqual(detailOf(upstream))
    expect(patched.readSubmodulePointer('lib/solady')).toBe('c')
  })

  it('reads a declared patch as-is when it is the contract being checked', () => {
    const reader = withAuditedPatches(head, substitutions, LIB)

    expect(reader.readFile(LIB)).toBe(PATCHED_LIB)
  })

  it('returns the reader unchanged when nothing is substituted', () => {
    expect(withAuditedPatches(head, new Map(), FACET)).toBe(head)
  })
})
