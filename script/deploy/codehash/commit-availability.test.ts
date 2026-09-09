/**
 * Lineage resolution's first step: making a record's commit locally readable.
 *
 * The fleet sweep measured that **56 of 98** audit commits are unreachable from
 * any local ref yet retrievable by SHA, so "not in this checkout" is not
 * evidence of anything. The failure this guards is the cheap one: reporting a
 * commit as unverifiable because nobody fetched it, which grades an honest
 * deploy grey and trains a signer to click through grey.
 *
 * And per T3/D3 the opposite failure is worse — a commit that genuinely cannot
 * be fetched must ERROR, distinctly from "absent", never fall through.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  ensureCommitAvailable,
  MAX_FETCH_ATTEMPTS,
} from './commit-availability'

const SHA = 'a'.repeat(40)

/**
 * @param script - what each git invocation should do, keyed by the subcommand
 */
const gitFrom = (script: {
  present: boolean[]
  fetch?: (attempt: number) => void
}) => {
  const calls: string[][] = []
  let presentIndex = 0
  let fetchAttempt = 0
  return {
    calls,
    git: (args: string[]): string => {
      calls.push(args)
      if (args[0] === 'cat-file') {
        const answer = script.present[presentIndex] ?? false
        presentIndex += 1
        if (!answer) throw new Error('Not a valid object name')
        return ''
      }
      if (args[0] === 'fetch') {
        fetchAttempt += 1
        script.fetch?.(fetchAttempt)
        return ''
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    },
  }
}

describe('ensureCommitAvailable', () => {
  it('does not fetch a commit the checkout already has', () => {
    const { git, calls } = gitFrom({ present: [true] })
    const result = ensureCommitAvailable(SHA, { git })

    expect(result).toEqual({ ok: true, fetched: false })
    expect(calls.map((c) => c[0])).toEqual(['cat-file'])
  })

  it('fetches by SHA when the commit is not reachable locally', () => {
    // The measured case: 56 of 98 audit commits look absent and are not.
    const { git, calls } = gitFrom({ present: [false, true] })
    const result = ensureCommitAvailable(SHA, { git })

    expect(result).toEqual({ ok: true, fetched: true })
    expect(calls.map((c) => c[0])).toEqual(['cat-file', 'fetch', 'cat-file'])
    // fetched by its SHA, not by a ref that may not contain it
    expect(calls[1]).toEqual(['fetch', '--quiet', 'origin', SHA])
  })

  it('retries a failing fetch up to the bound, then ERRORs', () => {
    const { git, calls } = gitFrom({
      present: [false, false, false],
      fetch: () => {
        throw new Error('could not read from remote repository')
      },
    })
    const result = ensureCommitAvailable(SHA, { git })

    expect(result.ok).toBe(false)
    if (result.ok) return
    // ERROR is its own outcome, distinct from "the commit does not exist"
    expect(result.kind).toBe('error')
    expect(result.reason).toMatch(/could not be fetched/)
    expect(calls.filter((c) => c[0] === 'fetch')).toHaveLength(
      MAX_FETCH_ATTEMPTS
    )
  })

  it('reports a fetch that succeeds but does not produce the commit as ERROR too', () => {
    // A remote that answers without the object is the same epistemic position:
    // nothing was learned, so nothing may be concluded.
    const { git } = gitFrom({ present: [false, false] })
    const result = ensureCommitAvailable(SHA, { git })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('error')
  })

  it('refuses a value that is not a full commit SHA without touching git', () => {
    // A short or malformed SHA passed to `git fetch` is an unbounded request
    // against the remote, and `cat-file` would resolve a prefix to whatever it
    // happens to match locally.
    for (const bad of [
      '',
      'abc',
      SHA.slice(0, 39),
      `${SHA}a`,
      'z'.repeat(40),
    ]) {
      const { git, calls } = gitFrom({ present: [true] })
      const result = ensureCommitAvailable(bad, { git })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.kind).toBe('refused')
      expect(calls).toEqual([])
    }
  })

  it('asks git for a commit specifically, not any object', () => {
    // A tree or blob with that SHA is not a commit, and resolving one would
    // make the lineage a hash nobody can check out.
    const { calls, git } = gitFrom({ present: [true] })
    ensureCommitAvailable(SHA, { git })

    expect(calls[0]).toEqual(['cat-file', '-e', `${SHA}^{commit}`])
  })

  it('bounds the fetch attempts at more than one, so a transient failure is survivable', () => {
    // A single attempt would turn one flaky network moment into an unverifiable
    // deploy; the bound exists so it neither gives up instantly nor spins.
    expect(MAX_FETCH_ATTEMPTS).toBeGreaterThan(1)
    expect(MAX_FETCH_ATTEMPTS).toBeLessThan(6)
  })
})
