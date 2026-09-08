/**
 * Covers where the pre-flight is wired in, not what it decides. Every case here
 * drives the real bash seam, the real CLI against real git state, or the real
 * deploy scripts; the decision itself is covered next to the module.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

  it.each([
    ['prod'],
    [''],
    ['PRODUCTION'],
    ['Production'],
    ['mystaging'],
    ['stagingg'],
  ])(
    'refuses %p, which is not the one value that means staging',
    (environment) => {
      // getPrivateKey hands out the production signing key for every ENVIRONMENT
      // that does not contain "staging", so matching the exact string keeps this
      // at least as broad as the key it protects. Only "production" and
      // "staging" are ever passed in practice, so a looser substring test would
      // differ only on a typo, where refusing is the safe direction.
      expect(runSeam(environment, 1)).toContain('SEAM_RC=1')
    }
  )

  it('warns for the exact string staging', () => {
    expect(runSeam('staging', 1)).toContain('SEAM_RC=0')
  })
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
/**
 * Puts a `git` on PATH that fails for one subcommand.
 *
 * @param subcommand - Matched at the subcommand position only. Scanning every
 * argument would also break unrelated calls that happen to take it as a flag
 * value.
 * @returns The stub directory to prepend to PATH.
 */
const gitFailingFor = (subcommand: string): string => {
  const stubDir = mkdtempSync(join(tmpdir(), 'tree-recordable-git-'))
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(
    join(stubDir, 'git'),
    `#!/bin/bash\n[ "$1" = "${subcommand}" ] && exit 128\nexec ${real} "$@"\n`
  )
  chmodSync(join(stubDir, 'git'), 0o755)
  return stubDir
}

describe('the CLI against real git state', () => {
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

  const shallowCloneOf = (source: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'tree-recordable-shallow-'))
    const target = join(root, 'clone')
    execFileSync('git', ['clone', '--depth', '1', `file://${source}`, target], {
      stdio: 'pipe',
    })
    return target
  }

  it('accepts a shallow clone whose HEAD a remote branch does contain', () => {
    // A depth-1 clone answers `--contains` correctly for a fetched tip, which is
    // the shape every CI checkout has. Refusing it outright would have been a
    // false refusal on the most common shallow state.
    expect(runCli(shallowCloneOf(makePushedClone()))).toBe(0)
  })

  it('refuses a shallow clone once HEAD moves off the fetched tip', () => {
    // Here a negative `--contains` cannot be trusted: the commit graph is
    // truncated, so "no remote branch has it" and "I cannot see that far" are
    // the same answer.
    const target = shallowCloneOf(makePushedClone())
    execFileSync('git', ['config', 'user.email', 't@e.c'], {
      cwd: target,
      stdio: 'pipe',
    })
    execFileSync('git', ['config', 'user.name', 't'], {
      cwd: target,
      stdio: 'pipe',
    })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
      cwd: target,
      stdio: 'pipe',
    })
    writeFileSync(join(target, 'src/Facet.sol'), 'moved on\n')
    execFileSync('git', ['commit', '-am', 'unpushed'], {
      cwd: target,
      stdio: 'pipe',
    })
    expect(runCli(target)).toBe(1)
  })
})
/**
 * Builds a pushed superproject with one real submodule under `lib/`.
 *
 * Real `lib/` in this repo is nine gitlinks and zero regular files, and
 * porcelain v1 reports a gitlink with nothing but untracked content inside it
 * identically to one left at a different commit — so a plain-file fixture
 * cannot reach either case.
 *
 * @returns The superproject clone and the two submodule commits.
 */
const makeSuperWithSubmodule = (): {
  clone: string
  pinned: string
  newer: string
} => {
  const root = mkdtempSync(join(tmpdir(), 'tree-recordable-sub-'))
  const g = (cwd: string, args: string[]): string =>
    execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  const identify = (cwd: string): void => {
    g(cwd, ['config', 'user.email', 'test@example.com'])
    g(cwd, ['config', 'user.name', 'test'])
    g(cwd, ['config', 'commit.gpgsign', 'false'])
  }

  const subOrigin = join(root, 'sub.git')
  const subWork = join(root, 'subwork')
  execFileSync('git', ['init', '--bare', '-b', 'main', subOrigin], {
    stdio: 'pipe',
  })
  execFileSync('git', ['clone', subOrigin, subWork], { stdio: 'pipe' })
  identify(subWork)
  writeFileSync(join(subWork, 'Dep.sol'), 'v1\n')
  g(subWork, ['add', '-A'])
  g(subWork, ['commit', '-m', 'v1'])
  writeFileSync(join(subWork, 'Dep.sol'), 'v2\n')
  g(subWork, ['commit', '-am', 'v2'])
  g(subWork, ['push', 'origin', 'main'])
  const newer = g(subWork, ['rev-parse', 'HEAD']).trim()
  const pinned = g(subWork, ['rev-parse', 'HEAD~1']).trim()

  const superOrigin = join(root, 'super.git')
  const clone = join(root, 'super')
  execFileSync('git', ['init', '--bare', '-b', 'main', superOrigin], {
    stdio: 'pipe',
  })
  execFileSync('git', ['clone', superOrigin, clone], { stdio: 'pipe' })
  identify(clone)
  g(clone, ['submodule', 'add', subOrigin, 'lib/dep'])
  g(join(clone, 'lib/dep'), ['checkout', pinned])
  g(clone, ['add', '-A'])
  g(clone, ['commit', '-m', 'pin dep'])
  g(clone, ['push', 'origin', 'main'])
  return { clone, pinned, newer }
}

describe('the CLI against real submodules', () => {
  it('accepts a submodule sitting at the pinned commit', () => {
    expect(runCli(makeSuperWithSubmodule().clone)).toBe(0)
  })

  it('refuses a submodule left at a different commit', () => {
    const { clone, newer } = makeSuperWithSubmodule()
    execFileSync('git', ['checkout', newer], {
      cwd: join(clone, 'lib/dep'),
      stdio: 'pipe',
    })
    expect(runCli(clone)).toBe(1)
  })

  it('ignores untracked content inside a submodule', () => {
    // A .DS_Store or a stray forge cache inside a lib makes porcelain report
    // the same ` M lib/x` as a moved gitlink, and neither `git stash` nor
    // `git add -A` clears it — so refusing here would block a production deploy
    // with no remedy the message could name.
    const { clone } = makeSuperWithSubmodule()
    writeFileSync(join(clone, 'lib/dep/.DS_Store'), 'junk\n')
    expect(runCli(clone)).toBe(0)
  })

  it('refuses when a submodule is not checked out at all', () => {
    // The state every fresh worktree starts in. Plain `git status` reports
    // nothing about it, so without the submodule read the guard would call a
    // tree missing its entire dependency set a match for the commit.
    const { clone } = makeSuperWithSubmodule()
    execFileSync('git', ['submodule', 'deinit', '-f', 'lib/dep'], {
      cwd: clone,
      stdio: 'pipe',
    })
    expect(runCli(clone)).toBe(1)
  })
})

describe('the CLI when git itself cannot answer', () => {
  it('refuses when git status cannot be read, rather than reading it as clean', () => {
    // The one input the guard's headline claim rests on, and the only one whose
    // failure value could be mistaken for a clean tree.
    const clone = makePushedClone()
    writeFileSync(join(clone, 'src/Facet.sol'), 'tampered\n')
    const result = spawnSync(process.execPath, [CLI], {
      cwd: clone,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${gitFailingFor('status')}:${process.env.PATH}`,
      },
    })

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain('could not be read')
  })
})

describe('the deploy script’s refusal branch', () => {
  /**
   * Runs deploySingleContract's guard block verbatim, with the seam stubbed to
   * refuse, and reports whether the enclosing function returned or the whole
   * shell exited.
   *
   * @param exitOnError - The 5th positional argument real callers pass.
   * @returns What the shell printed, including whether it survived the branch.
   */
  const runGuardBranch = (exitOnError: string): string => {
    const guard = readScript('script/deploy/deploySingleContract.sh')
      .split('\n')
      .slice(
        readScript('script/deploy/deploySingleContract.sh')
          .split('\n')
          .findIndex((line) => line.includes(CALL))
      )
    const block = guard.slice(0, guard.indexOf('  fi') + 1).join('\n')

    return spawnSync(
      'bash',
      [
        '-c',
        [
          `assertTreeRecordableOrFail() { return 1; }`,
          `deployDemo() {`,
          `  local ENVIRONMENT="production"`,
          `  local EXIT_ON_ERROR="$1"`,
          block,
          `  echo "REACHED THE BROADCAST"`,
          `}`,
          `deployDemo "$1"`,
          `echo "FUNCTION_RETURNED rc=$?"`,
        ].join('\n'),
        'bash',
        exitOnError,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    ).stdout
  }

  it.each([[''], ['false']])(
    'returns control to the caller when EXIT_ON_ERROR is %p',
    (exitOnError) => {
      // scriptMaster, deployCoreFacets and deployFacetAndAddToDiamond all pass
      // the literal string "false" and loop over networks or facets. An `exit`
      // here kills the whole session after the first one instead of letting the
      // loop report and continue.
      const output = runGuardBranch(exitOnError)

      expect(output).toContain('FUNCTION_RETURNED rc=1')
      expect(output).not.toContain('REACHED THE BROADCAST')
    }
  )

  it('exits the process when EXIT_ON_ERROR is true', () => {
    const output = runGuardBranch('true')

    expect(output).not.toContain('FUNCTION_RETURNED')
    expect(output).not.toContain('REACHED THE BROADCAST')
  })
})

describe('which remote counts as pushed', () => {
  it('refuses a commit pushed only to a remote that is not origin', () => {
    // `git branch -r --contains` answers for every remote the clone knows. This
    // repo has two (origin and tron), and a contributor can add a fork — none of
    // which makes the commit fetchable from the repository the record names.
    const clone = makePushedClone()
    const fork = mkdtempSync(join(tmpdir(), 'tree-recordable-fork-'))
    execFileSync('git', ['init', '--bare', '-b', 'main', join(fork, 'f.git')], {
      stdio: 'pipe',
    })
    execFileSync('git', ['remote', 'add', 'fork', join(fork, 'f.git')], {
      cwd: clone,
      stdio: 'pipe',
    })
    writeFileSync(join(clone, 'src/Facet.sol'), 'fork only\n')
    execFileSync('git', ['commit', '-am', 'fork only'], {
      cwd: clone,
      stdio: 'pipe',
    })
    execFileSync('git', ['push', 'fork', 'HEAD:refs/heads/feature'], {
      cwd: clone,
      stdio: 'pipe',
    })

    expect(
      execFileSync('git', ['branch', '-r', '--contains', 'HEAD'], {
        cwd: clone,
        encoding: 'utf8',
      })
    ).toContain('fork/feature')
    expect(
      spawnSync(process.execPath, [CLI], { cwd: clone, encoding: 'utf8' })
        .status
    ).toBe(1)
  })
})

describe('git configuration that hides a dirty tree', () => {
  it('sees an untracked source file despite status.showUntrackedFiles=no', () => {
    // A local or global setting, not something the deploy controls. Without an
    // explicit --untracked-files=all it silently removes untracked entries from
    // porcelain output, and a new src/ file stops being visible to the check.
    const clone = makePushedClone()
    execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], {
      cwd: clone,
      stdio: 'pipe',
    })
    writeFileSync(join(clone, 'src/Sneaky.sol'), 'new\n')

    expect(
      execFileSync('git', ['status', '--porcelain=v1'], {
        cwd: clone,
        encoding: 'utf8',
      })
    ).toBe('')
    expect(
      spawnSync(process.execPath, [CLI], { cwd: clone, encoding: 'utf8' })
        .status
    ).toBe(1)
  })
})

describe('submodule states the index and the disk disagree about', () => {
  it('refuses modified tracked content inside a submodule', () => {
    // `--ignore-submodules` has to be exactly `untracked`. At `dirty` this case
    // goes silent, and tampered source inside a lib reaches production with the
    // guard green — the one mutation the rest of the suite does not kill.
    const { clone } = makeSuperWithSubmodule()
    writeFileSync(join(clone, 'lib/dep/Dep.sol'), 'TAMPERED\n')

    expect(runCli(clone)).toBe(1)
  })

  it('accepts a populated submodule whose URL is absent from .git/config', () => {
    // What `git submodule status` calls uninitialized. The primary deploy clone
    // is in exactly this state for lib/ds-test: nine files on disk, resolved by
    // remappings, and a rebuild reproduces — so refusing it would block an
    // honest production deploy from the operator's own clean checkout.
    const { clone } = makeSuperWithSubmodule()
    for (const key of ['submodule.lib/dep.url', 'submodule.lib/dep.active'])
      execFileSync('git', ['config', '--unset', key], {
        cwd: clone,
        stdio: 'pipe',
      })

    expect(
      execFileSync('git', ['submodule', 'status'], {
        cwd: clone,
        encoding: 'utf8',
      })
    ).toMatch(/^-/)
    expect(runCli(clone)).toBe(0)
  })

  it('refuses when the index cannot be read at all', () => {
    const clone = makePushedClone()
    const result = spawnSync(process.execPath, [CLI], {
      cwd: clone,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${gitFailingFor('ls-files')}:${process.env.PATH}`,
      },
    })

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain(
      'index could not be read'
    )
  })
})

describe('a submodule directory that is not a checked-out repository', () => {
  const deinit = (clone: string): void => {
    execFileSync('git', ['submodule', 'deinit', '-f', 'lib/dep'], {
      cwd: clone,
      stdio: 'pipe',
    })
  }

  it.each([
    ['an ignored dotfile', '.DS_Store', 'junk\n'],
    ['a scratch file', 'notes.txt', 'junk\n'],
  ])('refuses a deinitialised submodule holding only %s', (_l, name, body) => {
    // Counting directory entries is not enough. `--ignore-submodules=untracked`
    // makes porcelain silent about untracked-only submodule content, so this
    // one file would otherwise satisfy both checks at once and the whole
    // dependency set could be absent with the guard green.
    const { clone } = makeSuperWithSubmodule()
    deinit(clone)
    writeFileSync(join(clone, 'lib/dep', name), body)

    expect(runCli(clone)).toBe(1)
  })

  it('refuses a deinitialised submodule holding only an empty directory', () => {
    const { clone } = makeSuperWithSubmodule()
    deinit(clone)
    mkdirSync(join(clone, 'lib/dep/src'), { recursive: true })

    expect(runCli(clone)).toBe(1)
  })

  it('refuses when the submodule path is unreadable', () => {
    // Fail closed: git cannot resolve an unreadable path as a repository root.
    // Asserts nothing where the mode bits do not apply — as root the directory
    // stays readable and the submodule resolves, so there is no refusal to make.
    const { clone } = makeSuperWithSubmodule()
    const path = join(clone, 'lib/dep')
    chmodSync(path, 0o000)
    const readable = (() => {
      try {
        readdirSync(path)
        return true
      } catch {
        return false
      }
    })()
    const status = readable ? 1 : runCli(clone)
    chmodSync(path, 0o755)

    expect(status).toBe(1)
  })

  it('reports the whole repository from a subdirectory', () => {
    // `git ls-files` is scoped to the cwd subtree, unlike every other read the
    // CLI makes, so a run from anywhere but the root would see no gitlinks.
    const { clone } = makeSuperWithSubmodule()
    deinit(clone)
    mkdirSync(join(clone, 'script'), { recursive: true })

    expect(runCli(join(clone, 'script'))).toBe(1)
  })
})
