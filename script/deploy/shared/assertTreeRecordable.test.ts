/**
 * The recordability pre-flight is only worth anything where it is wired in.
 * A green decision suite has twice let a guard ship into the wrong place, so
 * these run the real bash seam, drive the real CLI against real git state, and
 * read the real deploy scripts, rather than asserting about `tree-recordable.ts`.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SEAM = 'script/deploy/shared/assertTreeRecordable.sh'
const CLI = join(import.meta.dir, 'assert-tree-recordable.ts')

const readScript = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), 'utf8')

const CALL = 'assertTreeRecordableOrFail "$ENVIRONMENT"'

const WIRED_SCRIPTS = [
  ['script/deploy/deploySingleContract.sh'],
  ['script/deploy/deployAndStoreCREATE3Factory.sh'],
] as const

/**
 * Runs the seam with a stubbed CLI, so the status under test is the seam's own
 * routing decision and not a verdict about this checkout.
 *
 * @param environment - Passed to `assertTreeRecordableOrFail`.
 * @param cliExitCode - What the stubbed `bunx` exits with.
 * @returns Everything the seam printed, including its own `SEAM_RC=` line.
 */
const runSeam = (environment: string, cliExitCode: number): string => {
  const stubDir = mkdtempSync(join(tmpdir(), 'tree-recordable-stub-'))
  const bunx = join(stubDir, 'bunx')
  writeFileSync(
    bunx,
    `#!/bin/bash\necho "REFUSAL TEXT FROM CLI"\nexit ${cliExitCode}\n`
  )
  chmodSync(bunx, 0o755)

  const result = spawnSync(
    'bash',
    [
      '-c',
      [
        `PATH="${stubDir}:$PATH"`,
        `error() { echo "ERROR:$*"; }`,
        `warning() { echo "WARNING:$*"; }`,
        `source ${SEAM}`,
        CALL.replace('$ENVIRONMENT', '$1'),
        `echo "SEAM_RC=$?"`,
      ].join('\n'),
      'bash',
      environment,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
  return `${result.stdout}${result.stderr}`
}

describe('assertTreeRecordableOrFail — the bash seam', () => {
  it('delegates to the recordability CLI, not to some other script', () => {
    // The stubbed-bunx tests above would pass just as well if the seam invoked
    // an unrelated script, or one that no longer exists.
    const seam = readScript(SEAM)
    const cliPath = 'script/deploy/shared/assert-tree-recordable.ts'

    expect(seam).toContain(`bunx tsx ${cliPath}`)
    expect(existsSync(join(REPO_ROOT, cliPath))).toBe(true)
  })

  it('passes a recordable tree through', () => {
    const output = runSeam('production', 0)
    expect(output).toContain('SEAM_RC=0')
    expect(output).not.toContain('ERROR:')
    expect(output).not.toContain('WARNING:')
  })

  it('refuses a production deploy when the check refuses', () => {
    const output = runSeam('production', 1)
    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('ERROR:Refusing to deploy')
    // The seam must not swallow the CLI's reasons; the verdict alone says nothing
    // about which path is dirty.
    expect(output).toContain('REFUSAL TEXT FROM CLI')
  })

  it('warns but continues for a staging deploy', () => {
    // `deploy-smoke-test.yml` runs the whole deployAllContracts pipeline at
    // ENVIRONMENT=staging from a shallow `actions/checkout` on a merge commit
    // that is on no remote branch. Refusing there fails a workflow that makes
    // no production record.
    const output = runSeam('staging', 1)
    expect(output).toContain('SEAM_RC=0')
    expect(output).toContain('WARNING:Continuing anyway')
    expect(output).toContain('REFUSAL TEXT FROM CLI')
    expect(output).not.toContain('ERROR:')
  })

  it.each([['prod'], [''], ['PRODUCTION'], ['Production'], ['production ']])(
    'refuses %p, because that reaches the production key',
    (environment) => {
      // `getPrivateKey` (helperFunctions.sh) signs with
      // PRIVATE_KEY_PRODUCTION for every ENVIRONMENT that does not contain
      // "staging" — a typo included. Classifying those as non-production here
      // would exempt real production deploys from the gate.
      expect(runSeam(environment, 1)).toContain('SEAM_RC=1')
    }
  )

  it.each([['staging'], ['staging.'], ['mystaging'], ['stagingg']])(
    'warns for %p, matching getPrivateKey exactly',
    (environment) => {
      expect(runSeam(environment, 1)).toContain('SEAM_RC=0')
    }
  )
})

describe('the wiring in the deploy scripts', () => {
  it.each(WIRED_SCRIPTS)('%s sources the seam and calls it', (relativePath) => {
    const source = readScript(relativePath)
    expect(source).toContain(`source ${SEAM}`)
    expect(source).toContain(CALL)
  })

  it.each(WIRED_SCRIPTS)(
    '%s calls it before anything broadcasts',
    (relativePath) => {
      const lines = readScript(relativePath).split('\n')
      const callIndex = lines.findIndex((line) => line.includes(CALL))
      const firstBroadcastIndex = lines.findIndex((line) =>
        line.includes('--broadcast')
      )

      expect(callIndex).toBeGreaterThan(-1)
      expect(firstBroadcastIndex).toBeGreaterThan(-1)
      expect(callIndex).toBeLessThan(firstBroadcastIndex)
    }
  )

  it('calls it outside deploySingleContract’s retry loop', () => {
    // The `forge script --broadcast` calls sit inside a retry loop. A pre-flight
    // placed inside it would re-run per attempt, and a later attempt would be
    // gated only after an earlier one had already broadcast.
    const lines = readScript('script/deploy/deploySingleContract.sh').split(
      '\n'
    )
    const callIndex = lines.findIndex((line) => line.includes(CALL))
    const retryLoopIndex = lines.findIndex((line) =>
      line.includes('while [ $attempts -le')
    )

    expect(retryLoopIndex).toBeGreaterThan(-1)
    expect(callIndex).toBeLessThan(retryLoopIndex)
  })

  it.each(WIRED_SCRIPTS)('%s does not swallow the refusal', (relativePath) => {
    // The neighbouring `contractDependencyReminder.ts` call ends in `|| true`
    // because it is a best-effort reminder. This one must do the opposite.
    const callLine = readScript(relativePath)
      .split('\n')
      .find((line) => line.includes(CALL))

    expect(callLine).toBeDefined()
    expect(callLine).not.toContain('|| true')
    expect(callLine).not.toContain('2>/dev/null')
  })
})

describe('the CLI against real git state', () => {
  /**
   * Builds a repository that satisfies the pre-flight: a full clone whose HEAD
   * is contained by a remote branch.
   *
   * @returns Path to the working clone.
   */
  const makePushedClone = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'tree-recordable-repo-'))
    const origin = join(root, 'origin.git')
    const clone = join(root, 'clone')
    const git = (cwd: string, args: string[]): void => {
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
    }

    execFileSync('git', ['init', '--bare', '-b', 'main', origin], {
      stdio: 'pipe',
    })
    execFileSync('git', ['clone', origin, clone], { stdio: 'pipe' })
    git(clone, ['config', 'user.email', 'test@example.com'])
    git(clone, ['config', 'user.name', 'test'])
    git(clone, ['config', 'commit.gpgsign', 'false'])

    for (const path of ['src', 'lib', 'deployments', 'script'])
      mkdirSync(join(clone, path), { recursive: true })
    for (const path of [
      'src/Facet.sol',
      'lib/Dep.sol',
      'foundry.toml',
      'remappings.txt',
      'foundry.lock',
      'deployments/mainnet.json',
      'script/deploy.sh',
    ])
      writeFileSync(join(clone, path), 'original\n')

    git(clone, ['add', '-A'])
    git(clone, ['commit', '-m', 'initial'])
    git(clone, ['push', 'origin', 'main'])
    return clone
  }

  /**
   * Runs the real CLI in the given directory.
   *
   * @param cwd - Directory the CLI reads git from.
   * @returns The CLI's own exit status. Never taken after a pipe, where `$?`
   * would be the last filter's status instead.
   */
  const runCli = (cwd: string): number | null =>
    spawnSync(process.execPath, [CLI], { cwd, encoding: 'utf8' }).status

  const withEdit = (relativePath: string): number | null => {
    const clone = makePushedClone()
    writeFileSync(join(clone, relativePath), 'edited\n')
    return runCli(clone)
  }

  it('accepts a clean tree on a pushed commit', () => {
    expect(runCli(makePushedClone())).toBe(0)
  })

  it.each([
    ['src/Facet.sol'],
    ['lib/Dep.sol'],
    ['foundry.toml'],
    ['remappings.txt'],
    ['foundry.lock'],
  ])('refuses when %s is dirty', (relativePath) => {
    expect(withEdit(relativePath)).toBe(1)
  })

  it.each([['deployments/mainnet.json'], ['script/deploy.sh']])(
    'stays silent when only %s is dirty',
    (relativePath) => {
      // A deploy writes `deployments/` itself, and dirty deploy scripting
      // changes how a deploy was performed, not what a rebuild produces.
      expect(withEdit(relativePath)).toBe(0)
    }
  )

  it('refuses an untracked build-affecting file', () => {
    const clone = makePushedClone()
    writeFileSync(join(clone, 'src/New.sol'), 'new\n')
    expect(runCli(clone)).toBe(1)
  })

  it('ignores the untracked typechain symlink every worktree carries', () => {
    // `contracts-wt-add.sh` leaves an untracked `typechain` symlink in every
    // worktree. A deny-everything-else rule would refuse every deploy from one.
    const clone = makePushedClone()
    execFileSync('ln', ['-s', '/tmp', join(clone, 'typechain')], {
      stdio: 'pipe',
    })
    expect(runCli(clone)).toBe(0)
  })

  it('refuses a commit that is on no remote branch', () => {
    const clone = makePushedClone()
    writeFileSync(join(clone, 'src/Facet.sol'), 'committed but unpushed\n')
    execFileSync('git', ['commit', '-am', 'unpushed'], {
      cwd: clone,
      stdio: 'pipe',
    })
    expect(runCli(clone)).toBe(1)
  })

  it('refuses a shallow clone, where pushed and unpushed are indistinguishable', () => {
    const clone = makePushedClone()
    const shallow = mkdtempSync(join(tmpdir(), 'tree-recordable-shallow-'))
    const target = join(shallow, 'clone')
    execFileSync('git', ['clone', '--depth', '1', `file://${clone}`, target], {
      stdio: 'pipe',
    })
    expect(runCli(target)).toBe(1)
  })
})
