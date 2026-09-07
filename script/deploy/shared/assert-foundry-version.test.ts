/**
 * Covers where the foundry-version pre-flight is wired in, and that it fails
 * closed. Every case drives the real bash seam, the real checker and the real
 * deploy scripts; only the `forge` binary itself is substituted, because the
 * drifted case cannot be produced any other way.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
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
const SEAM = 'script/deploy/shared/assertFoundryVersion.sh'
const CHECKER = 'script/utils/verify-foundry-version.sh'
const CALL = 'assertFoundryVersionOrFail'
const PINNED = readFileSync(join(REPO_ROOT, '.foundry-version'), 'utf8').trim()

const readScript = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), 'utf8')

/**
 * Every deploy entry point named in EXSC-932. `diamondUpdateFacet.sh` is in the
 * list and is deliberately not edited by this change.
 */
const ENTRY_POINTS = [
  ['script/deploy/deploySingleContract.sh'],
  ['script/deploy/deployAndStoreCREATE3Factory.sh'],
  ['script/tasks/diamondUpdateFacet.sh'],
  ['script/tasks/updateFacetConfig.sh'],
  ['script/tasks/acceptOwnershipTransferPeriphery.sh'],
  ['script/tasks/checkExecutorAndReceiver.sh'],
] as const

/**
 * Puts a `forge` of a chosen version on PATH.
 *
 * @param version - Version the stub reports, in the newer `forge --version`
 * layout. Omit to produce a PATH with no `forge` at all.
 * @returns The stub directory to prepend to PATH.
 */
const forgeStub = (version?: string): string => {
  const stubDir = mkdtempSync(join(tmpdir(), 'foundry-version-stub-'))
  if (version !== undefined) {
    const forge = join(stubDir, 'forge')
    writeFileSync(
      forge,
      `#!/bin/bash\necho "forge Version: ${version}"\necho "Commit SHA: deadbeef"\n`
    )
    chmodSync(forge, 0o755)
  }
  return stubDir
}

/**
 * PATH with every directory that carries a real `forge` removed, so the
 * absent-forge case is reproducible on a developer machine that has one. CI
 * runs the TypeScript suite without foundry, where this removes nothing.
 *
 * @returns The filtered PATH value.
 */
const pathWithoutForge = (): string =>
  (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => dir !== '' && !existsSync(join(dir, 'forge')))
    .join(':')

/**
 * Puts a `git` on PATH that answers `rev-parse --show-toplevel` with a chosen
 * directory, so the seam's checker lookup can be pointed at a tree that does or
 * does not carry the checker.
 *
 * @param root - Directory to report as the repository root.
 * @returns The stub directory to prepend to PATH.
 */
const gitRootStub = (root: string): string => {
  const stubDir = mkdtempSync(join(tmpdir(), 'foundry-version-git-'))
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(
    join(stubDir, 'git'),
    `#!/bin/bash\nif [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then\n  echo "${root}"\n  exit 0\nfi\nexec ${real} "$@"\n`
  )
  chmodSync(join(stubDir, 'git'), 0o755)
  return stubDir
}

/**
 * Builds a tree that looks like a checkout to the seam.
 *
 * @param withChecker - Whether to place a copy of the real checker in it.
 * @returns Path to the tree.
 */
const fakeRoot = (withChecker: boolean): string => {
  const root = mkdtempSync(join(tmpdir(), 'foundry-version-root-'))
  writeFileSync(join(root, '.foundry-version'), `${PINNED}\n`)
  if (withChecker) {
    mkdirSync(join(root, 'script', 'utils'), { recursive: true })
    copyFileSync(join(REPO_ROOT, CHECKER), join(root, CHECKER))
  }
  return root
}

/**
 * Runs the real seam.
 *
 * @param options - `forgeVersion` omitted means no `forge` on PATH;
 * `gitRoot` redirects the checker lookup; `environment` is exported so the
 * no-exemption cases are driven, not argued.
 * @returns Everything the seam printed, including its own `SEAM_RC=` line.
 */
const runSeam = (options: {
  forgeVersion?: string
  gitRoot?: string
  environment?: string
}): string => {
  const stubs = [forgeStub(options.forgeVersion)]
  if (options.gitRoot !== undefined) stubs.push(gitRootStub(options.gitRoot))

  const result = spawnSync(
    'bash',
    [
      '-c',
      [
        `PATH="${stubs.join(':')}:${pathWithoutForge()}"`,
        `export ENVIRONMENT="${options.environment ?? 'production'}"`,
        `error() { echo "ERROR:$*"; }`,
        `warning() { echo "WARNING:$*"; }`,
        `source ${SEAM}`,
        CALL,
        `echo "SEAM_RC=$?"`,
      ].join('\n'),
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
  return `${result.stdout}${result.stderr}`
}

describe('assertFoundryVersionOrFail — the bash seam', () => {
  it('delegates to the checker CI and pre-commit already run', () => {
    // Without this the cases below would pass just as well against a second,
    // divergent implementation of the same comparison.
    expect(readScript(SEAM)).toContain(CHECKER)
    expect(existsSync(join(REPO_ROOT, CHECKER))).toBe(true)
  })

  it('passes a matching forge through silently', () => {
    const output = runSeam({ forgeVersion: PINNED })
    expect(output).toContain('SEAM_RC=0')
    expect(output).not.toContain('ERROR:')
    expect(output.replace('SEAM_RC=0\n', '')).toBe('')
  })

  it('refuses a drifted forge', () => {
    const output = runSeam({ forgeVersion: '9.9.9' })
    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('ERROR:')
    // The verdict alone does not say which version is installed, and the
    // expected value proves the real .foundry-version was read.
    expect(output).toContain('foundry version mismatch')
    expect(output).toContain(PINNED)
    expect(output).toContain('9.9.9')
  })

  it('refuses when forge is not installed at all', () => {
    const output = runSeam({})
    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('forge not on PATH')
  })

  it('refuses when the checker itself is missing', () => {
    const output = runSeam({
      forgeVersion: PINNED,
      gitRoot: fakeRoot(false),
    })
    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('ERROR:')
  })

  it('passes through the same redirected root once the checker is there', () => {
    // The counterpart to the case above: without it, a seam that refused for
    // any redirected root would look identical.
    const output = runSeam({
      forgeVersion: PINNED,
      gitRoot: fakeRoot(true),
    })
    expect(output).toContain('SEAM_RC=0')
    expect(output).not.toContain('ERROR:')
  })

  it.each([['staging'], ['testnet'], ['']])(
    'still refuses when ENVIRONMENT is %p',
    (environment) => {
      // A drifted compiler produces irreproducible bytecode on a testnet too,
      // and the seam takes no environment argument, so there is nothing to
      // exempt.
      expect(runSeam({ forgeVersion: '9.9.9', environment })).toContain(
        'SEAM_RC=1'
      )
    }
  )

  it.each([['staging'], ['testnet'], ['']])(
    'still passes a matching forge when ENVIRONMENT is %p',
    (environment) => {
      expect(runSeam({ forgeVersion: PINNED, environment })).toContain(
        'SEAM_RC=0'
      )
    }
  )
})

/**
 * Reduces a line to what bash would run, dropping comments, leading keywords and
 * leading environment assignments.
 *
 * @param line - A single line of a shell script.
 * @returns The command-position remainder, or an empty string for a comment.
 */
const commandPositionOf = (line: string): string => {
  let rest = line.trim()
  if (rest.startsWith('#')) return ''

  let changed = true
  while (changed) {
    changed = false
    for (const prefix of ['if ', 'elif ', 'while ', 'until ', 'then ', '! ']) {
      if (rest.startsWith(prefix)) {
        rest = rest.slice(prefix.length).trimStart()
        changed = true
      }
    }
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+/
    if (assignment.test(rest)) {
      rest = rest.replace(assignment, '')
      changed = true
    }
  }

  return rest
}

/**
 * True when the line starts a forge process — either the PATH `forge` the pin
 * governs, or the separately pinned `./foundry-zksync/forge` fork — rather than
 * mentioning one inside a string that is handed to the seam.
 *
 * @param line - A single line of a shell script.
 * @returns Whether a forge process would be started by this line.
 */
const invokesForgeDirectly = (line: string): boolean =>
  /^(?:\.\/foundry-zksync\/)?forge\s/.test(commandPositionOf(line))

/**
 * Index of the first line that actually *calls* the gate — the seam function
 * itself, or `executeAndParse`, which calls it. A mention inside a comment does
 * not count: the placement assertions were vacuous while it did, and passed with
 * the gate deleted and the comment left behind.
 *
 * @param lines - Lines of a shell script.
 * @returns The line index, or -1 when the file never calls the gate.
 */
const firstGateCallIndex = (lines: string[]): number =>
  lines.findIndex((line) =>
    /^(?:assertFoundryVersionOrFail|executeAndParse)\b/.test(
      commandPositionOf(line)
    )
  )

/**
 * Index of the first line that calls the seam function itself, ignoring
 * comments that merely name it.
 *
 * @param lines - Lines of a shell script.
 * @returns The line index, or -1 when the file never calls it.
 */
const firstSeamCallIndex = (lines: string[]): number =>
  lines.findIndex((line) =>
    new RegExp(`^${CALL}\\b`).test(commandPositionOf(line))
  )

describe('invokesForgeDirectly', () => {
  it.each([
    ['forge build'],
    ['  forge build --skip test'],
    ['if ! forge build --contracts x --silent; then'],
    ['FOUNDRY_PROFILE=zksync ./foundry-zksync/forge build --zksync'],
    ['PRIVATE_KEY="$KEY" forge script X.s.sol'],
  ])('detects %p', (line) => {
    expect(invokesForgeDirectly(line)).toBe(true)
  })

  it.each([
    ['# forge build'],
    ['COMMAND="NETWORK=$NETWORK forge script $SCRIPT_PATH"'],
    ['"NETWORK=$NETWORK forge script X.s.sol --broadcast" \\'],
    ['echo "run forge build first"'],
    ['executeAndParse \\'],
  ])('does not flag %p', (line) => {
    expect(invokesForgeDirectly(line)).toBe(false)
  })
})

describe('firstGateCallIndex', () => {
  it.each([
    [['  if ! assertFoundryVersionOrFail; then']],
    [['  assertFoundryVersionOrFail || return 1']],
    [['  executeAndParse \\']],
    [['      if ! executeAndParse \\']],
  ])('finds the call in %p', (lines) => {
    expect(firstGateCallIndex(lines)).toBe(0)
  })

  it.each([
    [['  # Also checked at the shared executeAndParse seam, but the zk path']],
    [['  # if ! assertFoundryVersionOrFail; then']],
    [['  echo "executeAndParse runs the command"']],
  ])('does not count %p as a call', (lines) => {
    expect(firstGateCallIndex(lines)).toBe(-1)
  })
})

describe('the wiring in helperFunctions.sh', () => {
  const lines = readScript('script/helperFunctions.sh').split('\n')
  const indexOf = (needle: string): number =>
    lines.findIndex((line) => line.includes(needle))

  it('sources the seam', () => {
    expect(indexOf(`source ${SEAM}`)).toBeGreaterThan(-1)
  })

  it('gates executeAndParse before it reaches executeAndCapture', () => {
    const functionIndex = indexOf('function executeAndParse()')
    const callIndex = firstSeamCallIndex(lines.slice(functionIndex))
    const captureIndex = lines
      .slice(functionIndex)
      .findIndex((line) => line.includes('RESULT=$(executeAndCapture'))

    expect(functionIndex).toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    expect(captureIndex).toBeGreaterThan(-1)
    expect(callIndex).toBeLessThan(captureIndex)
  })

  it('does not swallow the refusal', () => {
    const functionIndex = indexOf('function executeAndParse()')
    const callLine = lines.find(
      (line, index) => index > functionIndex && line.includes(CALL)
    )

    expect(callLine).toBeDefined()
    expect(callLine).not.toContain('|| true')
    expect(callLine).not.toContain('2>/dev/null')
  })
})

describe('the placement at every deploy entry point', () => {
  it.each(ENTRY_POINTS)('%s still drives forge at all', (relativePath) => {
    // Guards the two assertions below against the case where they hold because
    // the file stopped being a forge entry point.
    const source = readScript(relativePath)
    expect(/forge (?:script|build)/.test(source)).toBe(true)
  })

  it.each(ENTRY_POINTS)('%s calls the gate', (relativePath) => {
    const lines = readScript(relativePath).split('\n')
    expect(firstGateCallIndex(lines)).toBeGreaterThan(-1)
  })

  it.each(ENTRY_POINTS)(
    '%s cannot start a forge before the gate has run',
    (relativePath) => {
      const lines = readScript(relativePath).split('\n')
      const directForgeIndex = lines.findIndex(invokesForgeDirectly)

      // Infinity rather than a conditional assertion: a file with no
      // command-position forge has nothing to order against, but the comparison
      // must still fail when the gate call is missing entirely (index -1).
      expect(firstGateCallIndex(lines)).toBeLessThan(
        directForgeIndex === -1 ? Number.POSITIVE_INFINITY : directForgeIndex
      )
      expect(firstGateCallIndex(lines)).toBeGreaterThan(-1)
    }
  )

  it('leaves diamondUpdateFacet.sh unedited, covered through the seam', () => {
    // lifinance/contracts#2324 is open against this file. It reaches the gate
    // because its forge invocations are strings handed to executeAndParse.
    const source = readScript('script/tasks/diamondUpdateFacet.sh')
    expect(source).not.toContain(CALL)
    expect(source).toContain('executeAndParse')
    expect(source.split('\n').some(invokesForgeDirectly)).toBe(false)
  })

  it('gates deploySingleContract before its own build steps', () => {
    // Its zk path builds and derives the CREATE2 salt through
    // `ensureStandardArtifactForSalt`, both of which start a forge before the
    // first executeAndParse. The seam alone would fire too late here.
    const lines = readScript('script/deploy/deploySingleContract.sh').split(
      '\n'
    )
    const callIndex = firstSeamCallIndex(lines)
    const buildIndex = lines.findIndex(
      (line) =>
        invokesForgeDirectly(line) ||
        commandPositionOf(line).startsWith('ensureStandardArtifactForSalt')
    )

    expect(callIndex).toBeGreaterThan(-1)
    expect(buildIndex).toBeGreaterThan(-1)
    expect(callIndex).toBeLessThan(buildIndex)
  })

  it('gates deploySingleContract outside its retry loop', () => {
    const lines = readScript('script/deploy/deploySingleContract.sh').split(
      '\n'
    )
    const callIndex = firstSeamCallIndex(lines)
    const retryLoopIndex = lines.findIndex((line) =>
      line.includes('while [ $attempts -le')
    )

    expect(retryLoopIndex).toBeGreaterThan(-1)
    // Without this the comparison held for a missing call too, at index -1.
    expect(callIndex).toBeGreaterThan(-1)
    expect(callIndex).toBeLessThan(retryLoopIndex)
  })
})

/**
 * Drives the real `executeAndParse` with a chosen `forge` on PATH and a command
 * that leaves a file behind, so "refused" and "ran anyway" are distinguishable.
 *
 * @param forgeVersion - Version the stubbed `forge` reports.
 * @param seed - When set, primes the result globals with a success payload
 * before the call.
 * @param invoke - When false, the call is skipped, so the seeded globals can be
 * observed on their own.
 * @returns The seam's status, the globals it left, and whether the command ran.
 */
const runExecuteAndParse = (
  forgeVersion: string,
  seed = false,
  invoke = true
): { output: string; commandRan: boolean } => {
  const stubDir = forgeStub(forgeVersion)
  const sentinel = join(stubDir, 'command-ran')
  const seedLines = seed
    ? [
        `RAW_RETURN_DATA='{"logs":["x"],"returns":{"0":{"value":"ok"}}}'`,
        `RETURN_CODE=0`,
      ]
    : []

  const result = spawnSync(
    'bash',
    [
      '-c',
      [
        `PATH="${stubDir}:${pathWithoutForge()}"`,
        `source script/helperFunctions.sh >/dev/null 2>&1`,
        ...seedLines,
        invoke
          ? `executeAndParse "touch ${sentinel}" "false" "" "return" >/dev/null`
          : `true`,
        `echo "PARSE_RC=$?"`,
        `echo "RETURN_CODE=\${RETURN_CODE:-unset}"`,
        `echo "RAW=\${RAW_RETURN_DATA:-unset}"`,
      ].join('\n'),
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )

  return {
    output: `${result.stdout}${result.stderr}`,
    commandRan: existsSync(sentinel),
  }
}

describe('executeAndParse — the shared forge seam', () => {
  it('runs the command when the local forge matches', () => {
    const { output, commandRan } = runExecuteAndParse(PINNED)
    expect(output).toContain('PARSE_RC=0')
    expect(commandRan).toBe(true)
  })

  it('refuses without running the command when the local forge has drifted', () => {
    const { output, commandRan } = runExecuteAndParse('9.9.9')
    expect(output).toContain('PARSE_RC=1')
    expect(commandRan).toBe(false)
  })

  it('does not leave an earlier success in the result globals', () => {
    // `checkExecutorAndReceiver.sh` and `acceptOwnershipTransferPeriphery.sh`
    // ignore the status and read the globals through
    // `handleForgeScriptError`, so a stale payload would read as a completed
    // forge run.
    const { output, commandRan } = runExecuteAndParse('9.9.9', true)
    expect(commandRan).toBe(false)
    expect(output).toContain('RETURN_CODE=1')
    expect(output).toContain('RAW=unset')
  })

  it('leaves the seeded globals in place when nothing clears them', () => {
    // Proves the case above observes the refusal clearing them, and not a
    // harness in which the seed never took effect.
    const { output } = runExecuteAndParse(PINNED, true, false)
    expect(output).toContain('RETURN_CODE=0')
    expect(output).toContain('"returns"')
    expect(output).not.toContain('RAW=unset')
  })
})

describe('the deploy script’s refusal branch', () => {
  /**
   * Runs deploySingleContract's guard block verbatim with the seam refusing, and
   * reports whether the enclosing function returned or the whole shell exited.
   *
   * @param exitOnError - The 5th positional argument real callers pass.
   * @returns What the shell printed, including whether it survived the branch.
   */
  const runGuardBranch = (exitOnError: string): string => {
    const lines = readScript('script/deploy/deploySingleContract.sh').split(
      '\n'
    )
    const guard = lines.slice(firstSeamCallIndex(lines))
    const block = guard.slice(0, guard.indexOf('  fi') + 1).join('\n')

    return spawnSync(
      'bash',
      [
        '-c',
        [
          `${CALL}() { return 1; }`,
          `error() { echo "ERROR:$*"; }`,
          `deployDemo() {`,
          `  local EXIT_ON_ERROR="$1"`,
          block,
          `  echo "REACHED THE BUILD"`,
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
      const output = runGuardBranch(exitOnError)
      expect(output).toContain('FUNCTION_RETURNED rc=1')
      expect(output).not.toContain('REACHED THE BUILD')
    }
  )

  it('exits the shell when EXIT_ON_ERROR is "true"', () => {
    const output = runGuardBranch('true')
    expect(output).not.toContain('REACHED THE BUILD')
    expect(output).not.toContain('FUNCTION_RETURNED')
  })
})
