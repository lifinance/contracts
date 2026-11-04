/**
 * Covers `script/utils/scan-staged-secrets.sh`, the pre-commit secret scan: which staged lines
 * it reports, which it skips, and its exit codes. Every case runs the script for real against a
 * throwaway git repository with its own `.env`, so no case reads the checkout's secrets.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  afterEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { withholdCredentials } from '../deploy/safe/spawn-env'

const SCRIPT = join(import.meta.dir, 'scan-staged-secrets.sh')
const SECRET = 'fixture-secret-value-1234'
const SECRET_KEY = 'MY_API_KEY'
const PRIVATE_KEY = `0x${'ab'.repeat(32)}`
const MARKER = 'pre-commit-checker: not a secret'

interface IScanResult {
  status: number | null
  output: string
}

const repos: string[] = []

const childEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value
  }
  withholdCredentials(env)
  env['GIT_CONFIG_GLOBAL'] = '/dev/null'
  env['GIT_CONFIG_NOSYSTEM'] = '1'
  return env
}

const git = (repo: string, ...args: string[]): void => {
  const result = spawnSync('git', args, {
    cwd: repo,
    env: childEnv(),
    encoding: 'utf8',
  })
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

const write = (repo: string, path: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), content)
}

/**
 * Creates a repository with one commit, so later writes show up as a staged diff against HEAD.
 *
 * @param env - Content of the repository's `.env`, or null for no `.env` file.
 * @param committed - Files committed in the initial commit.
 * @returns The repository path.
 */
const makeRepo = (
  env: string | null,
  committed: Record<string, string> = {}
): string => {
  const repo = mkdtempSync(join(tmpdir(), 'scan-staged-secrets-'))
  repos.push(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  write(repo, '.gitignore', '.env\n')
  for (const [path, content] of Object.entries(committed))
    write(repo, path, content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'initial')
  if (env !== null) write(repo, '.env', env)
  return repo
}

const stage = (repo: string, files: Record<string, string | Buffer>): void => {
  for (const [path, content] of Object.entries(files))
    write(repo, path, content)
  git(repo, 'add', '-A')
}

const scan = (repo: string): IScanResult => {
  const result = spawnSync('bash', [SCRIPT], {
    cwd: repo,
    env: childEnv(),
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

afterEach(() => {
  for (const repo of repos.splice(0))
    rmSync(repo, { recursive: true, force: true })
})

describe('scan-staged-secrets .env values', () => {
  it('blocks an added line that contains a .env value and names the key', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`)
    stage(repo, { 'src/config.ts': `const a = 1\nconst key = '${SECRET}'\n` })

    const { status, output } = scan(repo)

    expect(status).toBe(1)
    expect(output).toContain(
      `[src/config.ts:2] Secret from .env file found (key: ${SECRET_KEY})`
    )
  })

  it('reports every key whose value appears on the line', () => {
    const repo = makeRepo(
      `FIRST_TOKEN=${SECRET}\nSECOND_TOKEN=other-secret-value\n`
    )
    stage(repo, { 'a.txt': `${SECRET} other-secret-value\n` })

    const { output } = scan(repo)

    expect(output).toContain(
      '[a.txt:1] Secret from .env file found (key: FIRST_TOKEN)'
    )
    expect(output).toContain(
      '[a.txt:1] Secret from .env file found (key: SECOND_TOKEN)'
    )
  })

  it('reports the line number in the staged file when lines above are unchanged', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`, {
      'a.txt': 'one\ntwo\nthree\n',
    })
    stage(repo, { 'a.txt': `one\ntwo\nthree\nfour ${SECRET}\n` })

    expect(scan(repo).output).toContain('[a.txt:4] Secret from .env file found')
  })

  it('ignores a .env value on a line the commit does not add', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`, {
      'a.txt': `old ${SECRET}\n`,
    })
    stage(repo, { 'a.txt': `old ${SECRET}\nnew line\n` })

    expect(scan(repo).status).toBe(0)
  })

  it('skips a line carrying the not-a-secret marker', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`)
    stage(repo, { 'a.ts': `const key = '${SECRET}' // ${MARKER}\n` })

    expect(scan(repo).status).toBe(0)
  })

  it('skips a line below the marker, also when the marker line is unchanged', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`, {
      'a.ts': `// ${MARKER}\n`,
    })
    stage(repo, { 'a.ts': `// ${MARKER}\nconst key = '${SECRET}'\n` })

    expect(scan(repo).status).toBe(0)
  })

  it('does not skip a line two below the marker', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`)
    stage(repo, {
      'a.ts': `// ${MARKER}\nconst a = 1\nconst key = '${SECRET}'\n`,
    })

    expect(scan(repo).output).toContain('[a.ts:3] Secret from .env file found')
  })

  it('matches values with regex metacharacters and a leading dash literally', () => {
    const repo = makeRepo(
      'REGEX_SECRET=a.b*c[d]+e\nDASH_SECRET=-dash-secret-value\n'
    )
    stage(repo, {
      'literal.txt': 'x a.b*c[d]+e x\n-dash-secret-value\n',
      'lookalike.txt': 'aXbbbc[d]e abbbcde\n',
    })

    const { status, output } = scan(repo)

    expect(status).toBe(1)
    expect(output).toContain(
      '[literal.txt:1] Secret from .env file found (key: REGEX_SECRET)'
    )
    expect(output).toContain(
      '[literal.txt:2] Secret from .env file found (key: DASH_SECRET)'
    )
    expect(output).not.toContain('lookalike.txt')
  })

  it('does not track false positives, path keys, allowlists or short non-secret values', () => {
    const repo = makeRepo(
      [
        'FLAG=true',
        'OUTPUT_PATH=deployments/output-folder',
        'EXCLUDE_NETWORKS=localanvil,mainnet',
        'NETWORK=bsc',
        '# COMMENTED=commented-out-secret',
        '',
      ].join('\n')
    )
    stage(repo, {
      'a.txt': 'true deployments/output-folder localanvil,mainnet bsc\n',
    })

    expect(scan(repo).status).toBe(0)
  })

  it('tracks a short value under a sensitive key name', () => {
    const repo = makeRepo('SHORT_TOKEN=abc12\n')
    stage(repo, { 'a.txt': 'value abc12\n' })

    expect(scan(repo).output).toContain('(key: SHORT_TOKEN)')
  })

  it('strips quotes and a trailing comment from .env values', () => {
    const repo = makeRepo(`${SECRET_KEY}="${SECRET}" # production key\n`)
    stage(repo, { 'a.txt': `${SECRET}\n` })

    expect(scan(repo).status).toBe(1)
  })

  it('does not scan excluded paths', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`)
    stage(repo, {
      'config/networks.json': `{"a": "${SECRET}"}\n`,
      'lib/x/a.sol': `${SECRET}\n`,
    })

    expect(scan(repo).status).toBe(0)
  })

  it('reports paths with spaces and colons unescaped', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`)
    stage(repo, { 'dir with space/a:b.txt': `${SECRET}\n` })

    expect(scan(repo).output).toContain(
      '[dir with space/a:b.txt:1] Secret from .env file found'
    )
  })

  it('reports a path git quotes with its quotes removed', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`)
    stage(repo, { 'a"b.txt': `${SECRET}\n` })

    expect(scan(repo).output).toContain(
      '[a\\"b.txt:1] Secret from .env file found'
    )
  })

  it('does not report a .env value that appears only in the path', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`)
    stage(repo, { [`${SECRET}.txt`]: 'harmless\n' })

    expect(scan(repo).status).toBe(0)
  })

  it('keeps paths and line numbers right after a hunk that removes lines', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`, {
      'a.txt': 'one\ntwo\nthree\nfour\n',
      'b.txt': 'first\n',
    })
    stage(repo, {
      'a.txt': 'one\nfour\n',
      'b.txt': `first\nsecond ${SECRET}\n`,
    })

    expect(scan(repo).output).toContain('[b.txt:2] Secret from .env file found')
  })

  it('scans binary files as text', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`)
    stage(repo, {
      'blob.bin': Buffer.concat([
        Buffer.from([0, 1, 2, 0]),
        Buffer.from(SECRET),
      ]),
    })

    expect(scan(repo).status).toBe(1)
  })

  it('treats an added line that starts with "++" as content, not a diff header', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`, { 'a.txt': 'one\n' })
    stage(repo, { 'a.txt': `one\n++ ${SECRET}\n--- removed-looking line\n` })

    expect(scan(repo).output).toContain('[a.txt:2] Secret from .env file found')
  })

  it('passes without a .env file', () => {
    const repo = makeRepo(null)
    stage(repo, { 'a.txt': `${SECRET}\n` })

    const { status, output } = scan(repo)

    expect(status).toBe(0)
    expect(output).toContain('Secret check passed')
  })
})

describe('scan-staged-secrets private keys', () => {
  it('warns about a 64-hex-character value without blocking', () => {
    const repo = makeRepo(null)
    stage(repo, { 'a.ts': `const pk = '${PRIVATE_KEY}'\n` })

    const { status, output } = scan(repo)

    expect(status).toBe(0)
    expect(output).toContain(
      `Potential private key found:\na.ts:1:const pk = '${PRIVATE_KEY}'`
    )
    expect(output).toContain('Secret check completed (warnings only)')
  })

  it('does not warn about a 64-hex-character path', () => {
    const repo = makeRepo(null)
    stage(repo, { [`${'ab'.repeat(32)}.txt`]: 'harmless\n' })

    expect(scan(repo).output).toContain('Secret check passed')
  })

  it('ignores longer hex strings and marked lines', () => {
    const repo = makeRepo(null)
    stage(repo, {
      'a.ts': `const data = '0x${'ab'.repeat(
        40
      )}'\nconst pk = '${PRIVATE_KEY}' // ${MARKER}\n`,
    })

    expect(scan(repo).output).toContain('Secret check passed')
  })

  it('blocks on a .env value even when private keys are also found', () => {
    const repo = makeRepo(`${SECRET_KEY}=${SECRET}\n`)
    stage(repo, { 'a.ts': `'${PRIVATE_KEY}'\n'${SECRET}'\n` })

    const { status, output } = scan(repo)

    expect(status).toBe(1)
    expect(output).toContain('Potential private key found:')
  })
})
