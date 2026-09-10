/**
 * What the audit bridge must report, and what it must never do.
 *
 * The failure mode this module has to avoid is the opposite of the usual one.
 * A per-deploy version gate would refuse every london-chain deploy as
 * unaudited, which is routine work, so the tests here are as much about the
 * bridge staying quiet when it should as about it speaking when it must.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  auditCoverageNotes,
  VETTED_COMPILER_SETS,
  type IAuditRecord,
  type IDeployedBuild,
} from './audit-build-bridge'

const CLOSURE = `0x${'11'.repeat(32)}` // pre-commit-checker: not a secret — a synthetic closure hash
const OTHER_CLOSURE = `0x${'22'.repeat(32)}` // pre-commit-checker: not a secret — a synthetic closure hash

/** A build that is fully bridged, so each test can spoil exactly one thing. */
const BRIDGED: IDeployedBuild = {
  contractName: 'CBridgeFacet',
  version: '1.2.0',
  profile: 'default',
  solcVersion: '0.8.29',
  evmVersion: 'cancun',
  sourceClosureHash: CLOSURE,
}

const AUDITED: IAuditRecord = {
  auditIds: ['audit20250508'],
  sourceClosureHash: CLOSURE,
}

const notesOf = (
  build: Partial<IDeployedBuild>,
  audit: Partial<IAuditRecord> = {}
): string[] =>
  auditCoverageNotes({ ...BRIDGED, ...build }, { ...AUDITED, ...audit }).map(
    (entry) => entry.note
  )

describe('auditCoverageNotes', () => {
  it('says nothing about a build that is audited, vetted and closure-matched', () => {
    // The paired present for every note below: the bridge can be quiet, so a
    // note means something rather than being the only thing it ever produces.
    expect(notesOf({})).toEqual([])
  })

  it('reports a contract with no audit at that version', () => {
    expect(notesOf({}, { auditIds: [] })).toContain('no-audit-recorded')
  })

  it('reports a profile nobody has vetted', () => {
    expect(notesOf({ profile: 'experimental' })).toContain('profile-not-vetted')
  })

  it('reports a vetted profile whose pin has moved under it', () => {
    // The profile name agreeing is not the compiler set agreeing: what ran is
    // then not what was reviewed, and only the versions can say so.
    expect(notesOf({ solcVersion: '0.8.30' })).toContain('compiler-set-differs')
    expect(notesOf({ evmVersion: 'prague' })).toContain('compiler-set-differs')
  })

  it('reports a zk build whose fork or LLVM version differs from the vetted set', () => {
    // Named separately so a variant can be built without spreading an optional.
    const zkToolchain = {
      zksolcVersion: '1.5.15',
      solcForkVersion: '0.8.29',
      llvmVersion: '1.0.2',
    }
    const zksync: IDeployedBuild = {
      ...BRIDGED,
      profile: 'zksync',
      zk: zkToolchain,
    }

    // Present: the vetted zk set is reachable, so the notes below are about the
    // versions rather than about zk builds never matching.
    expect(auditCoverageNotes(zksync, AUDITED)).toEqual([])
    expect(
      auditCoverageNotes(
        { ...zksync, zk: { ...zkToolchain, llvmVersion: '1.0.3' } },
        AUDITED
      ).map((entry) => entry.note)
    ).toContain('compiler-set-differs')
  })

  it('reports a build carrying a zk toolchain under an EVM profile', () => {
    // A missing zk section and a present one are different builds; treating
    // absent as "matches whatever is vetted" would bless either as the other.
    // The mirror case — the zk profile with no zk section — is not a mismatch
    // but an unchecked half, and has its own test.
    expect(
      notesOf({
        zk: {
          zksolcVersion: '1.5.15',
          solcForkVersion: '0.8.29',
          llvmVersion: '1.0.2',
        },
      })
    ).toContain('compiler-set-differs')
  })

  it('names the zk toolchain in the mismatch detail', () => {
    // A zk build differs from the vetted set only in its zk half, so a detail
    // rendering solc alone prints the same string either side of the "but".
    const [reported] = auditCoverageNotes(
      {
        ...BRIDGED,
        profile: 'zksync',
        zk: {
          zksolcVersion: '1.5.16',
          solcForkVersion: '0.8.29',
          llvmVersion: '1.0.2',
        },
      },
      AUDITED
    )

    expect(reported?.note).toBe('compiler-set-differs')
    expect(reported?.detail).toContain('zksolc 1.5.15')
    expect(reported?.detail).toContain('LLVM 1.0.2')
  })

  it('treats a profile named after an Object prototype member as unvetted', () => {
    // A property read would resolve these against Object.prototype and report
    // a vetted compiler set that nobody wrote.
    for (const profile of [
      'toString',
      'constructor',
      'hasOwnProperty',
      '__proto__',
    ])
      expect(notesOf({ profile })).toContain('profile-not-vetted')
  })

  it('does not report a compiler set that differs only in case or whitespace', () => {
    // The record and foundry.toml do not agree on either, and a note over
    // formatting is a false red on a build that matches.
    expect(notesOf({ evmVersion: 'Cancun' })).toEqual([])
    expect(notesOf({ evmVersion: ' cancun ' })).toEqual([])
    expect(notesOf({ solcVersion: ' 0.8.29' })).toEqual([])
    expect(
      notesOf({
        profile: 'zksync',
        zk: {
          zksolcVersion: ' 1.5.15',
          solcForkVersion: '0.8.29',
          llvmVersion: '1.0.2',
        },
      })
    ).toEqual([])

    // Present: the check still separates on a real difference, so the
    // normalisation has not been widened into accepting another hardfork.
    expect(notesOf({ evmVersion: 'zkevm' })).toContain('compiler-set-differs')
  })

  it('names the vetting date in the mismatch detail', () => {
    // The date is the claim a signer weighs — that somebody read the
    // advisories for these versions — so it has to reach them.
    const [reported] = auditCoverageNotes(
      { ...BRIDGED, solcVersion: '0.8.30' },
      AUDITED
    )

    // The literal date, not the map's own field: an assertion read through
    // VETTED_COMPILER_SETS moves with any edit to it and pins nothing.
    expect(reported?.detail).toContain('2026-09-09')
  })

  it('reads one closure in two hex spellings as one closure', () => {
    // Every sibling module compares hashes through normalizeHash: the audit
    // log is hand-authored, so its spelling of a hash is not the build's.
    expect(
      notesOf({}, { sourceClosureHash: CLOSURE.slice(2).toUpperCase() })
    ).toEqual([])

    // Present: a genuinely different closure still reports.
    expect(notesOf({}, { sourceClosureHash: OTHER_CLOSURE })).toContain(
      'closure-differs'
    )
  })

  it('does not render a bare v for a record with no version', () => {
    // Two real attestation records carry an empty version.
    const [reported] = auditCoverageNotes(
      { ...BRIDGED, version: '' },
      { auditIds: [] }
    )

    expect(reported?.detail).toContain('an unrecorded version')
    expect(reported?.detail).not.toContain('at v')
  })

  it('reports a zk build whose toolchain nothing recorded, without calling it a mismatch', () => {
    // Only a bytecode trailer carries the fork and LLVM versions, so this is
    // what a caller assembling a zk build from the deployment record produces.
    expect(notesOf({ profile: 'zksync' })).toEqual(['zk-toolchain-unverified'])

    // Present: the solc and evm halves are still compared on that same build,
    // so the unverified note covers the zk half alone.
    expect(notesOf({ profile: 'zksync', solcVersion: '0.8.30' })).toEqual([
      'compiler-set-differs',
      'zk-toolchain-unverified',
    ])

    // Present: a build that does report a zk toolchain is still compared
    // against the vetted one, so the unverified note has not replaced the
    // check.
    expect(
      notesOf({
        profile: 'zksync',
        zk: {
          zksolcVersion: '1.5.15',
          solcForkVersion: '0.8.29',
          llvmVersion: '9.9.9',
        },
      })
    ).toEqual(['compiler-set-differs'])
  })

  it('does not read two unusable closures as a proved bridge', () => {
    // Empty strings are equal to each other, and a bridge proved by comparing
    // nothing to nothing is a false green rather than a quiet pass.
    expect(
      notesOf({ sourceClosureHash: '' }, { sourceClosureHash: '' })
    ).toEqual(['closure-unrecorded'])

    // The zero digest is a whole digest and is what an unset bytes32 encodes
    // to, so it is the one well-formed value that proves nothing.
    expect(
      notesOf(
        { sourceClosureHash: `0x${'00'.repeat(32)}` },
        { sourceClosureHash: `0x${'00'.repeat(32)}` }
      )
    ).toEqual(['closure-unrecorded'])

    // A sliced hash frames as valid hex and is not a digest.
    expect(
      notesOf(
        { sourceClosureHash: '0xdeadbeef' },
        { sourceClosureHash: '0xdeadbeef' }
      )
    ).toEqual(['closure-unrecorded'])
  })

  it('reports an audit that records no source closure', () => {
    // Most audits predate the field, which is the state this module exists to
    // make visible rather than to punish.
    expect(notesOf({}, { sourceClosureHash: undefined })).toContain(
      'closure-unrecorded'
    )
    expect(notesOf({ sourceClosureHash: undefined })).toContain(
      'closure-unrecorded'
    )
  })

  it('reports two closures that disagree', () => {
    // A swapped library changes the closure without changing the facet file,
    // which is why the closure and not the file is the unit.
    expect(notesOf({}, { sourceClosureHash: OTHER_CLOSURE })).toContain(
      'closure-differs'
    )
  })

  it('does not report both closure notes for one build', () => {
    // They answer different questions — cannot prove, versus proved wrong —
    // and reporting both would read as two problems where there is one.
    const unrecorded = notesOf({}, { sourceClosureHash: undefined })
    expect(unrecorded).toContain('closure-unrecorded')
    expect(unrecorded).not.toContain('closure-differs')
  })

  it('accumulates notes so one never hides another', () => {
    const notes = notesOf(
      { profile: 'experimental', sourceClosureHash: undefined },
      { auditIds: [] }
    )

    expect(notes).toEqual([
      'no-audit-recorded',
      'profile-not-vetted',
      'closure-unrecorded',
    ])
  })

  it('never refuses — every disposition is a note', () => {
    // The guarantee this module makes. A per-deploy version gate would brand
    // routine london-chain deploys unaudited, so the return type carries no
    // blocking state at all and this test pins that: the worst case is still
    // just a list of notes.
    const worst = auditCoverageNotes(
      {
        contractName: 'Unknown',
        version: '9.9.9',
        profile: 'experimental',
        solcVersion: '0.1.0',
        evmVersion: 'homestead',
      },
      { auditIds: [] }
    )

    // Pinned by note rather than by shape: `Array.isArray` and a typeof on
    // each entry both hold for an empty array, so they pass for a module that
    // produces nothing.
    expect(worst.map((entry) => entry.note)).toEqual([
      'no-audit-recorded',
      'profile-not-vetted',
      'closure-unrecorded',
    ])
    for (const entry of worst) expect(entry.detail).not.toBe('')
  })
})

describe('VETTED_COMPILER_SETS', () => {
  it('covers the three build profiles, each with a vetting date', () => {
    // Pinned by value: the point is which sets were reviewed, and an assertion
    // written through the map itself would move with any edit to it.
    expect(Object.keys(VETTED_COMPILER_SETS).sort()).toEqual([
      'default',
      'solc_floor',
      'zksync',
    ])
    expect(VETTED_COMPILER_SETS.default?.solcVersion).toBe('0.8.29')
    expect(VETTED_COMPILER_SETS.solc_floor?.solcVersion).toBe('0.8.17')
    expect(VETTED_COMPILER_SETS.zksync?.zk?.zksolcVersion).toBe('1.5.15')
    for (const set of Object.values(VETTED_COMPILER_SETS))
      expect(set.vettedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
  })
})
