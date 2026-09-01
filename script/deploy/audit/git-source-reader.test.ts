/**
 * Tests for the git seam the audit gate reads history through.
 *
 * These run against the real repository rather than a fixture, because the two
 * behaviours that matter here are properties of git itself: a commit unreachable
 * from any local ref must still be readable after a fetch, and an absent file
 * must be distinguishable from an unreadable commit. A fake would assert the
 * assumption instead of testing it.
 */

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  createClosureReader,
  createGitSourceReader,
  ensureCommitAvailable,
} from './git-source-reader'

const CWD = process.cwd()

/** A commit that exists but is not reachable from any local branch. */
const SQUASHED_AUDIT_COMMIT = 'a2bb57edd89f3c89f593994e3242cff3d1d93a93'
const ABSENT_COMMIT = 'dead1234dead1234dead1234dead1234dead1234'
const KNOWN_CONTRACT = 'src/Periphery/ERC20Proxy.sol'

describe('ensureCommitAvailable', () => {
  it('resolves a commit reachable from a local ref without fetching', () => {
    expect(ensureCommitAvailable('HEAD', CWD)).toBe(true)
  })

  it('fetches a commit that no local ref reaches', () => {
    expect(ensureCommitAvailable(SQUASHED_AUDIT_COMMIT, CWD)).toBe(true)
  })

  it('gives up on a commit that does not exist, rather than throwing', () => {
    expect(ensureCommitAvailable(ABSENT_COMMIT, CWD, 1)).toBe(false)
  })

  it('does not retry a commit already present locally', () => {
    // A zero-attempt budget would make any fetch impossible, so a true result
    // proves the local short-circuit ran ahead of the retry loop.
    expect(ensureCommitAvailable('HEAD', CWD, 0)).toBe(true)
  })
})

describe('createGitSourceReader', () => {
  it('reads a file that exists at the tree-ish', () => {
    const source = createGitSourceReader('HEAD', CWD).readFile(KNOWN_CONTRACT)

    expect(source).toContain('contract ERC20Proxy')
  })

  it('returns undefined for a path absent at the tree-ish', () => {
    const source = createGitSourceReader('HEAD', CWD).readFile(
      'src/Facets/ThisContractHasNeverExisted.sol'
    )

    expect(source).toBeUndefined()
  })

  it('memoises a miss, so an absent path is not re-shelled per import', () => {
    const reader = createGitSourceReader('HEAD', CWD)
    const first = reader.readFile('src/NotThere.sol')
    const second = reader.readFile('src/NotThere.sol')

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
  })

  it('returns undefined for a submodule pointer that is not a gitlink', () => {
    const pointer = createGitSourceReader('HEAD', CWD).readSubmodulePointer(
      KNOWN_CONTRACT
    )

    expect(pointer).toBeUndefined()
  })
})

describe('createClosureReader', () => {
  it('hashes the closure at the head tree-ish', () => {
    const hash = createClosureReader(CWD, 'HEAD')('HEAD', KNOWN_CONTRACT)

    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('is deterministic for the same tree-ish and contract', () => {
    const read = createClosureReader(CWD, 'HEAD')

    expect(read('HEAD', KNOWN_CONTRACT)).toBe(read('HEAD', KNOWN_CONTRACT))
  })

  // Generous timeout on purpose: giving up on an unfetchable commit costs three
  // sequential network fetches, which is the bounded-retry budget doing its job.
  it('reports unfetchable rather than hashing, when the commit cannot be had', () => {
    const hash = createClosureReader(CWD, 'HEAD')(ABSENT_COMMIT, KNOWN_CONTRACT)

    expect(hash).toBe('unfetchable')
  }, 30_000)

  it('reports contract-absent when the commit resolves but the file is not in it', () => {
    const hash = createClosureReader(CWD, 'HEAD')(
      'HEAD',
      'src/Facets/ThisContractHasNeverExisted.sol'
    )

    expect(hash).toBe('contract-absent')
  })

  it('distinguishes an absent contract from an unreachable commit', () => {
    const read = createClosureReader(CWD, 'HEAD')

    expect(read('HEAD', 'src/Nope.sol')).not.toBe(
      read(ABSENT_COMMIT, KNOWN_CONTRACT)
    )
  }, 30_000)

  it('gives a different hash at a historical commit than at head, when the closure drifted', () => {
    const read = createClosureReader(CWD, 'HEAD')

    expect(read(SQUASHED_AUDIT_COMMIT, KNOWN_CONTRACT)).not.toBe(
      read('HEAD', KNOWN_CONTRACT)
    )
  })
})
