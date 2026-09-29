/**
 * Which repository a network's deployed code is rebuilt from.
 *
 * Tron cut proposals are authored and deployed out of `lifinance/contracts-tron`
 * (`docs/TronFork.md`), so a Tron record's commit is not on `origin` at all and
 * whether it is readable must not depend on what a clone happens to carry.
 *
 * The failure in the other direction is the one with teeth: a `tron` remote
 * pointed at a proposer's own fork lets them author the very source the gate
 * grades them against, which is what `isTrustedRemote` exists to refuse.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  resolveSourceRemote,
  sourceRepositoryFor,
  TRON_SOURCE_REMOTE,
} from './source-remote'

const FORK_URL = 'git@github.com:lifinance/contracts-tron.git'

/**
 * @param urls - what `git remote get-url <name>` answers, by remote name
 */
const gitFrom = (urls: Record<string, string>) => {
  const calls: string[][] = []
  // A Map, so a remote named `constructor` is answered by this table and not
  // by the prototype.
  const table = new Map(Object.entries(urls))
  return {
    calls,
    git: (args: string[]): string => {
      calls.push(args)
      const name = args[2] as string
      const url = table.get(name)
      if (url === undefined) throw new Error(`error: No such remote '${name}'`)
      return `${url}\n`
    },
  }
}

describe('sourceRepositoryFor', () => {
  it('sends both Tron network keys to the fork', () => {
    expect(sourceRepositoryFor('tron')).toEqual({
      remote: TRON_SOURCE_REMOTE,
      repository: 'github.com/lifinance/contracts-tron',
    })
    expect(sourceRepositoryFor('tronshasta')?.remote).toBe(TRON_SOURCE_REMOTE)
  })

  it('leaves every other network on origin', () => {
    expect(sourceRepositoryFor('mainnet')).toBeUndefined()
    expect(sourceRepositoryFor('lens')).toBeUndefined()
  })
})

describe('resolveSourceRemote', () => {
  it('answers origin for an EVM network without consulting git', () => {
    const { git, calls } = gitFrom({})
    expect(resolveSourceRemote('mainnet', { git })).toEqual({
      ok: true,
      remote: 'origin',
    })
    expect(calls).toEqual([])
  })

  it('answers the fork remote for Tron when it names the fork', () => {
    const { git, calls } = gitFrom({ [TRON_SOURCE_REMOTE]: FORK_URL })
    expect(resolveSourceRemote('tron', { git })).toEqual({
      ok: true,
      remote: TRON_SOURCE_REMOTE,
    })
    expect(calls).toEqual([['remote', 'get-url', TRON_SOURCE_REMOTE]])
  })

  it('refuses with the remedy when the clone has no fork remote', () => {
    const { git } = gitFrom({
      origin: 'git@github.com:lifinance/contracts.git',
    })
    const result = resolveSourceRemote('tron', { git })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toContain('contracts-tron')
    expect(result.reason).toContain(`git remote add ${TRON_SOURCE_REMOTE}`)
  })

  it('refuses a fork remote pointed at another repository', () => {
    const { git } = gitFrom({
      [TRON_SOURCE_REMOTE]: 'git@github.com:someone/contracts-tron.git',
    })
    const result = resolveSourceRemote('tron', { git })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toContain('someone/contracts-tron')
  })

  it('refuses a fork remote read over cleartext, and says so', () => {
    const { git } = gitFrom({
      [TRON_SOURCE_REMOTE]: 'http://github.com/lifinance/contracts-tron.git',
    })
    const result = resolveSourceRemote('tron', { git })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    // The identity is right, so a message about the identity would point the
    // reader at the half that is fine.
    expect(result.reason).toContain('https or ssh')
  })

  it('accepts the https spelling of the fork', () => {
    const { git } = gitFrom({
      [TRON_SOURCE_REMOTE]: 'https://github.com/lifinance/contracts-tron.git',
    })
    expect(resolveSourceRemote('tron', { git }).ok).toBe(true)
  })
})
