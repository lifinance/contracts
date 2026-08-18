/**
 * Tests for fail-soft git provenance capture (EXSC-691).
 *
 * Capture sits on the Safe-proposal and deployment paths, both of which abort
 * on a thrown error, so the properties that matter most here are negative ones:
 * every probe failure degrades to a sentinel, nothing throws, and a failed
 * dirty-tree probe is distinguishable from a genuinely clean tree.
 *
 * All subprocess execution goes through the injected {@link CommandRunner}
 * seam — no test spawns a real `git` or `gh`, so results do not depend on the
 * checkout the suite happens to run in.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  captureGitProvenance,
  detectActor,
  getGitBranch,
  getGitCommit,
  getProposerHandle,
  getScopedDirtyTree,
  isCommitOnRemote,
  resetGitProvenanceCache,
  resolveOpenPrUrl,
  MAX_DIRTY_PATHS,
  PROVENANCE_UNKNOWN,
  type CommandRunner,
  type ICommandResult,
  type ProvenanceActor,
} from './git-provenance'

const SHA = 'a'.repeat(40)
const BRANCH = 'feat/exsc-691-provenance'
const PR_URL = 'https://github.com/lifinance/contracts/pull/2125'

const ok = (stdout: string): ICommandResult => ({
  status: 0,
  stdout,
  stderr: '',
})

const fail = (stderr = 'fatal: not a git repository'): ICommandResult => ({
  status: 128,
  stdout: '',
  stderr,
})

const missingBinary = (command: string): ICommandResult => ({
  status: null,
  stdout: '',
  stderr: '',
  error: new Error(`spawnSync ${command} ENOENT`),
})

/** Command lines a full happy-path capture issues, in the order it issues them. */
function happyHandlers(): Record<string, ICommandResult> {
  return {
    'git rev-parse --show-toplevel': ok('/repo'),
    'git config user.name': ok('Alice Example'),
    'git config user.email': ok('alice@example.com'),
    'git rev-parse HEAD': ok(SHA),
    'git rev-parse --abbrev-ref HEAD': ok(BRANCH),
    'git status --porcelain': ok(''),
    'git branch --remotes --contains': ok(`  origin/${BRANCH}`),
    'gh pr list': ok(PR_URL),
  }
}

/**
 * Builds a runner that matches each invocation against the longest-registered
 * command-line prefix, logging every command line for spawn assertions.
 */
function stubRunner(
  handlers: Record<string, ICommandResult>,
  log: string[] = [],
  envLog: Array<NodeJS.ProcessEnv | undefined> = []
): CommandRunner {
  return (command, args, options) => {
    const line = [command, ...args].join(' ')
    log.push(line)
    envLog.push(options.env)
    const key = Object.keys(handlers).find((candidate) =>
      line.startsWith(candidate)
    )
    return key ? (handlers[key] as ICommandResult) : fail(`unstubbed: ${line}`)
  }
}

/** Context with an empty environment so the host's CI vars cannot leak in. */
function contextWith(
  handlers: Record<string, ICommandResult>,
  extras: {
    env?: NodeJS.ProcessEnv
    errors?: string[]
    log?: string[]
    envLog?: Array<NodeJS.ProcessEnv | undefined>
  } = {}
) {
  return {
    env: extras.env ?? {},
    errors: extras.errors ?? [],
    run: stubRunner(handlers, extras.log, extras.envLog),
  }
}

beforeEach(() => {
  resetGitProvenanceCache()
})

afterEach(() => {
  resetGitProvenanceCache()
})

describe('detectActor', () => {
  const cases: Array<[string, NodeJS.ProcessEnv, boolean, ProvenanceActor]> = [
    [
      'GitHub Actions wins over everything',
      { GITHUB_ACTIONS: 'true', SAFE_PROPOSAL_ACTOR: 'bot' },
      true,
      'ci',
    ],
    ['CI=true', { CI: 'true' }, true, 'ci'],
    ['CI=1', { CI: '1' }, false, 'ci'],
    ['CI=false with a git identity is a human', { CI: 'false' }, true, 'human'],
    ['explicit bot opt-in', { SAFE_PROPOSAL_ACTOR: 'bot' }, true, 'bot'],
    ['git identity only', {}, true, 'human'],
    ['nothing identifies the caller', {}, false, PROVENANCE_UNKNOWN],
  ]

  for (const [name, env, hasIdentity, expected] of cases)
    it(`detects ${expected}: ${name}`, () => {
      expect(detectActor(env, hasIdentity)).toBe(expected)
    })
})

describe('captureGitProvenance — happy path', () => {
  it('populates every field and records no capture errors', () => {
    const provenance = captureGitProvenance(contextWith(happyHandlers()))

    expect(provenance).toEqual({
      actor: 'human',
      proposerHandle: 'Alice Example <alice@example.com>',
      gitCommit: SHA,
      gitBranch: BRANCH,
      dirtyTreeScoped: [],
      commitOnRemote: true,
      prUrl: PR_URL,
    })
    expect(provenance.captureErrors).toBeUndefined()
  })

  it('joins name and email, and falls back to whichever one resolves', () => {
    const nameOnly = happyHandlers()
    nameOnly['git config user.email'] = fail('not set')
    expect(getProposerHandle(contextWith(nameOnly))).toBe('Alice Example')

    const emailOnly = happyHandlers()
    emailOnly['git config user.name'] = fail('not set')
    expect(getProposerHandle(contextWith(emailOnly))).toBe('alice@example.com')
  })

  it('reports unknown handle and actor when no identity is configured', () => {
    const handlers = happyHandlers()
    handlers['git config user.name'] = fail('not set')
    handlers['git config user.email'] = fail('not set')

    const provenance = captureGitProvenance(contextWith(handlers))

    expect(provenance.proposerHandle).toBe(PROVENANCE_UNKNOWN)
    expect(provenance.actor).toBe(PROVENANCE_UNKNOWN)
    // An unset identity is a normal state, not a capture anomaly.
    expect(provenance.captureErrors).toBeUndefined()
  })
})

describe('captureGitProvenance — fail-soft behaviour', () => {
  it('never throws when the git binary is missing, and returns sentinels', () => {
    const errors: string[] = []
    const provenance = captureGitProvenance(
      contextWith(
        {
          'git ': missingBinary('git'),
          'gh ': missingBinary('gh'),
        },
        { errors }
      )
    )

    expect(provenance.gitCommit).toBe(PROVENANCE_UNKNOWN)
    expect(provenance.gitBranch).toBe(PROVENANCE_UNKNOWN)
    expect(provenance.actor).toBe(PROVENANCE_UNKNOWN)
    expect(provenance.proposerHandle).toBe(PROVENANCE_UNKNOWN)
    expect(provenance.dirtyTreeScoped).toEqual([])
    expect(provenance.commitOnRemote).toBeUndefined()
    expect(provenance.prUrl).toBeUndefined()
    expect(provenance.captureErrors?.length).toBeGreaterThan(0)
  })

  it('never throws when the runner itself blows up', () => {
    const exploding: CommandRunner = () => {
      throw new Error('runner exploded')
    }

    const provenance = captureGitProvenance({ env: {}, run: exploding })

    expect(provenance.gitCommit).toBe(PROVENANCE_UNKNOWN)
    expect(provenance.dirtyTreeScoped).toEqual([])
    expect(provenance.captureErrors).toEqual([
      'provenance capture failed: runner exploded',
    ])
  })

  it('degrades one field at a time: commit fails, branch survives', () => {
    const handlers = happyHandlers()
    handlers['git rev-parse HEAD'] = fail()

    const errors: string[] = []
    const provenance = captureGitProvenance(contextWith(handlers, { errors }))

    expect(provenance.gitCommit).toBe(PROVENANCE_UNKNOWN)
    expect(provenance.gitBranch).toBe(BRANCH)
    expect(provenance.captureErrors).toHaveLength(1)
    expect(provenance.captureErrors?.[0]).toContain('git rev-parse HEAD failed')
    // An unresolvable commit cannot be checked against remote refs.
    expect(provenance.commitOnRemote).toBeUndefined()
  })

  it('falls back to process.cwd() when the repo root cannot be resolved', () => {
    const handlers = happyHandlers()
    handlers['git rev-parse --show-toplevel'] = fail()

    const errors: string[] = []
    const provenance = captureGitProvenance(contextWith(handlers, { errors }))

    expect(provenance.gitCommit).toBe(SHA)
    expect(provenance.captureErrors?.[0]).toContain('--show-toplevel failed')
  })
})

describe('captureGitProvenance — dirty tree scoping', () => {
  const porcelain = [
    ' M deployments/mainnet.json',
    '?? deployments/arbitrum.json.lock',
    'M  deployments/mainnet.diamond.json',
    'M  script/deploy/_targetState.json',
    'M  src/Facets/Foo.sol',
    ' M config/whitelist.json',
  ].join('\n')

  it('keeps source and governance config, drops deploy-generated artefacts', () => {
    const handlers = happyHandlers()
    handlers['git status --porcelain'] = ok(porcelain)

    const provenance = captureGitProvenance(contextWith(handlers))

    expect(provenance.dirtyTreeScoped).toEqual([
      'config/whitelist.json',
      'src/Facets/Foo.sol',
    ])
    expect(provenance.dirtyTreeTruncated).toBeUndefined()
  })

  it('reports a clean tree with no capture errors', () => {
    const provenance = captureGitProvenance(contextWith(happyHandlers()))

    expect(provenance.dirtyTreeScoped).toEqual([])
    expect(provenance.captureErrors).toBeUndefined()
  })

  it('distinguishes a failed status probe from a clean tree', () => {
    const handlers = happyHandlers()
    handlers['git status --porcelain'] = fail()

    const provenance = captureGitProvenance(contextWith(handlers))

    expect(provenance.dirtyTreeScoped).toEqual([])
    expect(
      provenance.captureErrors?.some((entry) => entry.includes('git status'))
    ).toBe(true)
  })

  it('keeps the status column intact when the first entry is unstaged', () => {
    // An unstaged change reports a leading space (` M path`). Trimming stdout
    // would shift that first line left and eat the first character of its path,
    // which turned `.env.example` into `env.example`.
    const handlers = happyHandlers()
    handlers['git status --porcelain'] = ok(
      [' M .env.example', ' M src/Facets/Foo.sol', ''].join('\n')
    )

    expect(getScopedDirtyTree(contextWith(handlers)).paths).toEqual([
      '.env.example',
      'src/Facets/Foo.sol',
    ])
  })

  it('resolves a rename to its destination path', () => {
    const handlers = happyHandlers()
    handlers['git status --porcelain'] = ok(
      'R  src/Facets/Old.sol -> src/Facets/New.sol'
    )

    expect(getScopedDirtyTree(contextWith(handlers)).paths).toEqual([
      'src/Facets/New.sol',
    ])
  })

  it('unquotes paths git escaped, and skips malformed lines', () => {
    const handlers = happyHandlers()
    handlers['git status --porcelain'] = ok(
      ['M  "src/a b/\\"quoted\\".sol"', '', 'M ', 'xx'].join('\n')
    )

    expect(getScopedDirtyTree(contextWith(handlers)).paths).toEqual([
      'src/a b/"quoted".sol',
    ])
  })

  it('caps the list and flags truncation', () => {
    const many = Array.from(
      { length: MAX_DIRTY_PATHS + 10 },
      (_, index) => `M  src/File${String(index).padStart(3, '0')}.sol`
    ).join('\n')
    const handlers = happyHandlers()
    handlers['git status --porcelain'] = ok(many)

    const provenance = captureGitProvenance(contextWith(handlers))

    expect(provenance.dirtyTreeScoped).toHaveLength(MAX_DIRTY_PATHS)
    expect(provenance.dirtyTreeTruncated).toBe(true)
    expect(provenance.dirtyTreeScoped[0]).toBe('src/File000.sol')
  })

  it('deduplicates and sorts paths', () => {
    const handlers = happyHandlers()
    handlers['git status --porcelain'] = ok(
      ['M  src/B.sol', '?? src/A.sol', 'MM src/B.sol'].join('\n')
    )

    expect(getScopedDirtyTree(contextWith(handlers)).paths).toEqual([
      'src/A.sol',
      'src/B.sol',
    ])
  })
})

describe('isCommitOnRemote', () => {
  it('is true when a remote-tracking ref contains the commit', () => {
    expect(isCommitOnRemote(SHA, contextWith(happyHandlers()))).toBe(true)
  })

  it('is false when no remote ref contains it', () => {
    const handlers = happyHandlers()
    handlers['git branch --remotes --contains'] = ok('')
    expect(isCommitOnRemote(SHA, contextWith(handlers))).toBe(false)
  })

  it('is undefined when the probe fails', () => {
    const handlers = happyHandlers()
    handlers['git branch --remotes --contains'] = fail()
    expect(isCommitOnRemote(SHA, contextWith(handlers))).toBeUndefined()
  })

  it('is undefined for an unknown commit, without spawning git', () => {
    const log: string[] = []
    expect(
      isCommitOnRemote(
        PROVENANCE_UNKNOWN,
        contextWith(happyHandlers(), { log })
      )
    ).toBeUndefined()
    expect(log.some((line) => line.startsWith('git branch'))).toBe(false)
  })
})

describe('resolveOpenPrUrl', () => {
  it('returns the URL gh reports', () => {
    expect(resolveOpenPrUrl(BRANCH, contextWith(happyHandlers()))).toBe(PR_URL)
  })

  it('passes non-interactive gh environment hints', () => {
    const envLog: Array<NodeJS.ProcessEnv | undefined> = []
    resolveOpenPrUrl(BRANCH, contextWith(happyHandlers(), { envLog }))

    const ghEnv = envLog[envLog.length - 1]
    expect(ghEnv?.GH_PROMPT_DISABLED).toBe('1')
    expect(ghEnv?.GH_NO_UPDATE_NOTIFIER).toBe('1')
  })

  it('is undefined and silent when gh is not installed', () => {
    const handlers = happyHandlers()
    handlers['gh pr list'] = missingBinary('gh')
    const errors: string[] = []

    expect(
      resolveOpenPrUrl(BRANCH, contextWith(handlers, { errors }))
    ).toBeUndefined()
    // A missing or unauthenticated gh is the common case on a deployer machine
    // and must not surface as a capture anomaly on every proposal.
    expect(errors).toEqual([])
  })

  it('is undefined when gh reports no open PR', () => {
    const handlers = happyHandlers()
    handlers['gh pr list'] = ok('')
    expect(resolveOpenPrUrl(BRANCH, contextWith(handlers))).toBeUndefined()
  })

  it('ignores output that is not a URL', () => {
    const handlers = happyHandlers()
    handlers['gh pr list'] = ok('gh: command needs authentication')
    expect(resolveOpenPrUrl(BRANCH, contextWith(handlers))).toBeUndefined()
  })

  for (const branch of ['main', 'HEAD', PROVENANCE_UNKNOWN])
    it(`never spawns gh for branch "${branch}"`, () => {
      const log: string[] = []
      expect(
        resolveOpenPrUrl(branch, contextWith(happyHandlers(), { log }))
      ).toBeUndefined()
      expect(log.some((line) => line.startsWith('gh'))).toBe(false)
    })

  it('is skippable from a full capture', () => {
    const log: string[] = []
    const provenance = captureGitProvenance({
      ...contextWith(happyHandlers(), { log }),
      resolvePrUrl: false,
    })

    expect(provenance.prUrl).toBeUndefined()
    expect(log.some((line) => line.startsWith('gh'))).toBe(false)
  })
})

describe('captureGitProvenance — CI context', () => {
  const ciEnv = {
    GITHUB_ACTIONS: 'true',
    GITHUB_ACTOR: 'lifi-action-bot',
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_HEAD_REF: 'feat/from-ci',
  }

  it('prefers the workflow SHA, head ref and actor over local git state', () => {
    const handlers = happyHandlers()
    handlers['git config user.name'] = fail('not set')
    handlers['git config user.email'] = fail('not set')

    const provenance = captureGitProvenance(
      contextWith(handlers, { env: ciEnv })
    )

    expect(provenance.actor).toBe('ci')
    expect(provenance.proposerHandle).toBe('lifi-action-bot')
    expect(provenance.gitCommit).toBe(ciEnv.GITHUB_SHA)
    expect(provenance.gitBranch).toBe('feat/from-ci')
  })

  it('falls back to GITHUB_REF_NAME on a push event', () => {
    expect(
      getGitBranch(
        contextWith(happyHandlers(), {
          env: { CI: 'true', GITHUB_REF_NAME: 'main' },
        })
      )
    ).toBe('main')
  })

  it('falls back to the local probes when CI supplies no refs', () => {
    const provenance = captureGitProvenance(
      contextWith(happyHandlers(), { env: { CI: 'true' } })
    )

    expect(provenance.gitCommit).toBe(SHA)
    expect(provenance.gitBranch).toBe(BRANCH)
    // No GITHUB_ACTOR: the local identity is the best available answer.
    expect(provenance.proposerHandle).toBe('Alice Example <alice@example.com>')
  })
})

describe('captureGitProvenance — memoization', () => {
  it('spawns the probes once per process and reuses the result', () => {
    const log: string[] = []
    const context = contextWith(happyHandlers(), { log })

    const first = captureGitProvenance(context)
    const callsAfterFirst = log.length
    const second = captureGitProvenance(context)

    expect(callsAfterFirst).toBeGreaterThan(0)
    expect(log).toHaveLength(callsAfterFirst)
    expect(second).toEqual(first)
  })

  it('hands out copies so one caller cannot corrupt another', () => {
    const handlers = happyHandlers()
    handlers['git status --porcelain'] = ok('M  src/Facets/Foo.sol')
    const context = contextWith(handlers)

    const first = captureGitProvenance(context)
    first.dirtyTreeScoped.push('injected')

    expect(captureGitProvenance(context).dirtyTreeScoped).toEqual([
      'src/Facets/Foo.sol',
    ])
  })

  it('re-probes after the cache is reset', () => {
    const log: string[] = []
    const context = contextWith(happyHandlers(), { log })

    captureGitProvenance(context)
    const callsAfterFirst = log.length
    resetGitProvenanceCache()
    captureGitProvenance(context)

    expect(log.length).toBe(callsAfterFirst * 2)
  })

  it('preserves capture errors across cached reads', () => {
    const handlers = happyHandlers()
    handlers['git status --porcelain'] = fail()
    const context = contextWith(handlers)

    const first = captureGitProvenance(context)
    const second = captureGitProvenance(context)

    expect(first.captureErrors).toBeDefined()
    expect(second.captureErrors).toEqual(first.captureErrors ?? [])
    expect(second.captureErrors).not.toBe(first.captureErrors)
  })
})

describe('single-field helpers', () => {
  it('read HEAD and the branch through the same seam', () => {
    expect(getGitCommit(contextWith(happyHandlers()))).toBe(SHA)
    expect(getGitBranch(contextWith(happyHandlers()))).toBe(BRANCH)
  })

  it('honour an explicit cwd instead of resolving the repo root', () => {
    const log: string[] = []
    getGitCommit({
      ...contextWith(happyHandlers(), { log }),
      cwd: '/somewhere/else',
    })

    expect(log).toEqual(['git rev-parse HEAD'])
  })
})
