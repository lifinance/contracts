/**
 * What `freshChildEnv` and `sandboxCheckout` hand a spawned child: an
 * environment none of the developer's settings reach, and a cwd whose env file
 * is the test's rather than theirs. The credential sweep is covered by
 * `spawn-env-credentials.test.ts`.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'fs'
import { join } from 'path'

import {
  afterEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { freshChildEnv, sandboxCheckout } from './spawn-env'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

describe('freshChildEnv', () => {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME }

  afterEach(() => {
    process.env.PATH = saved.PATH
    process.env.HOME = saved.HOME
  })

  it('carries only PATH and HOME from this process', () => {
    const before = process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
    process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND = 'true'
    try {
      expect(freshChildEnv()).toEqual({
        PATH: saved.PATH ?? '',
        HOME: saved.HOME ?? '',
      })
    } finally {
      if (before === undefined) {
        delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
      } else {
        process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND = before
      }
    }
  })

  it('applies what the case sets over the base', () => {
    expect(freshChildEnv({ PATH: '/stub', TICKET: 'EXSC-1' })).toEqual({
      PATH: '/stub',
      HOME: saved.HOME ?? '',
      TICKET: 'EXSC-1',
    })
  })

  it('gives an empty value, not an unset one, for a name this process lacks', () => {
    delete process.env.HOME
    expect(freshChildEnv().HOME).toBe('')
  })
})

describe('sandboxCheckout', () => {
  let root = ''

  afterEach(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true })
    root = ''
  })

  it('writes the given lines ahead of the blank proposal-intent lines', () => {
    root = sandboxCheckout(['PRODUCTION=true'], [])

    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(
      'PRODUCTION=true\nSAFE_PROPOSAL_TICKET=\nSAFE_PROPOSAL_REASON=\n'
    )
  })

  it('links the named entries into this checkout and skips missing ones', () => {
    root = sandboxCheckout([], ['script', 'no-such-entry'])

    expect(lstatSync(join(root, 'script')).isSymbolicLink()).toBe(true)
    expect(realpathSync(readlinkSync(join(root, 'script')))).toBe(
      realpathSync(join(REPO_ROOT, 'script'))
    )
    expect(existsSync(join(root, 'no-such-entry'))).toBe(false)
  })

  it('links the entry points’ checkout entries by default', () => {
    root = sandboxCheckout()

    for (const entry of ['config', 'deployments', 'node_modules', 'script'])
      expect(lstatSync(join(root, entry)).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(
      'SAFE_PROPOSAL_TICKET=\nSAFE_PROPOSAL_REASON=\n'
    )
  })

  it('leaves the checkout in place when the sandbox is removed', () => {
    root = sandboxCheckout([], ['script'])
    rmSync(root, { recursive: true, force: true })
    root = ''

    expect(existsSync(join(REPO_ROOT, 'script', 'deploy', 'safe'))).toBe(true)
  })
})
