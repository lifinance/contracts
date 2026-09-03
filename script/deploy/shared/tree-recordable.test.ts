/**
 * A deployment record claims that rebuilding at its commit reproduces the
 * deployed bytecode. These assert the two ways that claim can be false before
 * anything is broadcast: the tree does not match the commit, or the commit is
 * not anywhere a verifier can fetch it.
 *
 * Fixtures are real `git status --porcelain=v1 -z --no-renames` output, NUL
 * separated, because the parse is where this can go quietly wrong.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  assertTreeRecordable,
  buildAffectingDirtyPaths,
  submodulePathsInIndex,
  type ITreeState,
} from './tree-recordable'

const z = (...entries: string[]): string =>
  entries.map((entry) => `${entry}\0`).join('')

const clean: ITreeState = {
  statusZ: '',
  head: 'a'.repeat(40),
  remoteRefsContainingHead: '  origin/main\n',
  absentSubmodulePaths: [],
  isShallow: false,
}

describe('buildAffectingDirtyPaths', () => {
  it('is empty for a clean tree', () => {
    expect(buildAffectingDirtyPaths('')).toEqual([])
  })

  it.each([
    ['a modified facet', ' M src/Facets/AcrossFacet.sol'],
    ['a staged facet', 'M  src/Facets/AcrossFacet.sol'],
    ['an untracked source file', '?? src/Facets/NewFacet.sol'],
    ['a deleted library', ' D src/Libraries/LibAsset.sol'],
    ['the compiler profile', ' M foundry.toml'],
    ['remappings', ' M remappings.txt'],
    ['a dependency', ' M lib/forge-std'],
  ])('reports %s', (_label, entry) => {
    expect(buildAffectingDirtyPaths(z(entry))).toHaveLength(1)
  })

  it.each([
    [
      'the deploy log a deploy run writes itself',
      ' M deployments/mainnet.json',
    ],
    [
      'forge broadcast artifacts',
      ' M broadcast/Deploy.s.sol/1/run-latest.json',
    ],
    ['the typechain symlink every worktree carries', '?? typechain'],
    ['a scratch note', '?? notes.md'],
    ['deploy scripting', ' M script/deploy/deploySingleContract.sh'],
  ])('does not report %s', (_label, entry) => {
    // None of these change the bytecode a rebuild at this commit produces, and
    // the first three are written by the deploy run or the worktree setup — a
    // refusal keyed on them would be red by construction.
    expect(buildAffectingDirtyPaths(z(entry))).toEqual([])
  })

  it('separates entries on NUL, not on whitespace', () => {
    // A path with a space in it is one entry, not two. Splitting on whitespace
    // would invent paths and could hide the real one.
    const paths = buildAffectingDirtyPaths(z(' M src/My Facet.sol'))

    expect(paths).toEqual(['src/My Facet.sol'])
  })

  it('reports every build-affecting path, not just the first', () => {
    const paths = buildAffectingDirtyPaths(
      z(' M src/A.sol', ' M deployments/x.json', ' M src/B.sol')
    )

    expect(paths).toEqual(['src/A.sol', 'src/B.sol'])
  })

  it('ignores a path that merely starts with a build directory name', () => {
    expect(buildAffectingDirtyPaths(z(' M srcnotes/x.txt'))).toEqual([])
  })

  it.each([
    [
      'an untracked directory under src',
      '?? src/NewFacets/',
      ['src/NewFacets/'],
    ],
    ['an untracked src itself', '?? src/', ['src/']],
    ['an untracked broadcast directory', '?? broadcast/', []],
    ['an untracked script directory', '?? script/', []],
  ])('handles %s, the collapsed form git actually emits', (_l, entry, want) => {
    // Verified against real `git status --porcelain=v1 -z --no-renames`: git
    // reports a wholly-untracked directory as one entry with a trailing slash
    // rather than listing its files, so the prefix test has to match that shape
    // too. Hand-written fixtures did not have it.
    expect(buildAffectingDirtyPaths(z(entry))).toEqual(want)
  })
})

describe('assertTreeRecordable', () => {
  it('passes on a clean, pushed tree', () => {
    expect(() => assertTreeRecordable(clean)).not.toThrow()
  })

  it('refuses a tree with build-affecting changes, naming them', () => {
    const error = (() => {
      try {
        assertTreeRecordable({
          ...clean,
          statusZ: z(' M src/Facets/AcrossFacet.sol'),
        })
        return undefined
      } catch (e) {
        return e as Error
      }
    })()

    expect(error?.message).toContain('src/Facets/AcrossFacet.sol')
    expect(error?.message).toMatch(/could not be verified later/i)
    // The verdict belongs to the caller: the same facts hard-block a production
    // deploy and only warn on staging.
    expect(error?.message).not.toMatch(/refusing/i)
  })

  it('refuses a commit no remote branch contains', () => {
    // The record would point at a commit a verifier cannot fetch, so the
    // rebuild it promises can never be performed.
    const error = (() => {
      try {
        assertTreeRecordable({ ...clean, remoteRefsContainingHead: '' })
        return undefined
      } catch (e) {
        return e as Error
      }
    })()

    expect(error?.message).toMatch(/on no origin branch/i)
    expect(error?.message).toContain(clean.head)
  })

  it('refuses when the commit hash could not be determined at all', () => {
    // `getCurrentGitCommitHash` returns the sentinel 'UNKNOWN' rather than
    // throwing. Recording that is recording nothing.
    const error = (() => {
      try {
        assertTreeRecordable({ ...clean, head: 'UNKNOWN' })
        return undefined
      } catch (e) {
        return e as Error
      }
    })()

    expect(error?.message).toMatch(/UNKNOWN/)
  })

  it('refuses a shallow clone whose HEAD no remote branch contains', () => {
    // A truncated commit graph cannot be trusted when `--contains` reports that
    // no remote branch has the commit; it can be when it reports that one does.
    const error = (() => {
      try {
        assertTreeRecordable({
          ...clean,
          isShallow: true,
          remoteRefsContainingHead: '',
        })
        return undefined
      } catch (e) {
        return e as Error
      }
    })()

    expect(error?.message).toMatch(/shallow clone/)
    // Not also the unpushed message: it cannot know that, and saying both would
    // send the operator to push a commit that may already be pushed.
    expect(error?.message).not.toMatch(/is on no origin branch/)
  })

  it('does not refuse a shallow clone whose HEAD a remote branch contains', () => {
    // The shape of every CI checkout. A blanket shallow refusal was a false
    // refusal here: a ref that contains the commit is a trustworthy answer
    // however truncated the history behind it is.
    expect(() =>
      assertTreeRecordable({ ...clean, isShallow: true })
    ).not.toThrow()
  })

  it('reports both problems at once rather than one per run', () => {
    // An operator fixing these one refusal at a time would need two deploy
    // attempts to learn about two problems.
    const error = (() => {
      try {
        assertTreeRecordable({
          ...clean,
          statusZ: z(' M src/A.sol'),
          head: 'b'.repeat(40),
          remoteRefsContainingHead: '',
        })
        return undefined
      } catch (e) {
        return e as Error
      }
    })()

    expect(error?.message).toContain('src/A.sol')
    expect(error?.message).toMatch(/on no origin branch/i)
  })
})

describe('submodulePathsInIndex', () => {
  const s = (...entries: string[]): string =>
    entries.map((entry) => `${entry}\0`).join('')

  it('is empty for an index with no submodules', () => {
    expect(submodulePathsInIndex(s('100644 abc 0\tsrc/Facet.sol'))).toEqual([])
  })

  it('is empty for empty input', () => {
    expect(submodulePathsInIndex('')).toEqual([])
  })

  it('reads only gitlinks, not regular files or symlinks', () => {
    expect(
      submodulePathsInIndex(
        s(
          '100644 aaa 0\tfoundry.toml',
          '160000 bbb 0\tlib/solady',
          '120000 ccc 0\ttypechain',
          '160000 ddd 0\tlib/forge-std'
        )
      )
    ).toEqual(['lib/solady', 'lib/forge-std'])
  })

  it('does not match a mode that merely starts with the gitlink digits', () => {
    // The trailing space is load-bearing: without it `1600000` would match.
    expect(submodulePathsInIndex(s('1600000 aaa 0\tlib/x'))).toEqual([])
  })

  it.each([
    ['a space', 'lib/with space/dep'],
    ['a tab', 'lib/tab\tdir/dep'],
    ['non-ASCII', 'lib/ünïcode/dep'],
  ])('keeps a path containing %s whole', (_label, path) => {
    // `-z` suppresses the quoting git otherwise applies to these, and the
    // separator tab always precedes the path — so the FIRST tab ends the
    // header, even when the path contains one of its own.
    expect(submodulePathsInIndex(s(`160000 aaa 0\t${path}`))).toEqual([path])
  })

  it('drops a trailing empty entry rather than reporting it as a path', () => {
    expect(submodulePathsInIndex(s('160000 aaa 0\t'))).toEqual([])
  })
})
