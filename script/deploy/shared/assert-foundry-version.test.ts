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

describe('the wiring in helperFunctions.sh', () => {
  const lines = readScript('script/helperFunctions.sh').split('\n')
  const indexOf = (needle: string): number =>
    lines.findIndex((line) => line.includes(needle))

  it('sources the seam', () => {
    expect(indexOf(`source ${SEAM}`)).toBeGreaterThan(-1)
  })

  it('gates executeAndParse before it reaches executeAndCapture', () => {
    const functionIndex = indexOf('function executeAndParse()')
    const body = lines.slice(functionIndex)
    const callIndex = body.findIndex(
      (line) => line.trim() === `if ! ${CALL}; then`
    )
    const captureIndex = body.findIndex((line) =>
      line.includes('RESULT=$(executeAndCapture')
    )

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

/**
 * Index of the exact gate-call line, matched whole so a comment or a string
 * body that merely names the function cannot stand in for it.
 *
 * Earlier revisions of this file classified shell lines to answer the same
 * question and were wrong four times in a row — a comment, a multi-line
 * double-quoted string, a heredoc body, and a forge started after `;`/`&&`/
 * `else`/`exec`. The placement claim now rests on running the scripts
 * (`every deploy entry point, driven for real`); this is a whole-line match
 * used only where a line number is genuinely needed.
 *
 * @param source - Whole file contents.
 * @returns The line index, or -1 when the exact call line is absent.
 */
const gateCallLineIndex = (source: string): number =>
  source.split('\n').findIndex((line) => line.trim() === `if ! ${CALL}; then`)

describe('the placement in deploySingleContract', () => {
  const SOURCE = readScript('script/deploy/deploySingleContract.sh')

  it('gates before its own build steps', () => {
    // Its zk path builds, and `ensureStandardArtifactForSalt` derives the
    // CREATE2 salt through a plain `forge build`; both start a forge before the
    // first executeAndParse, so the seam alone would fire too late here.
    const buildIndex = SOURCE.split('\n').findIndex((line) =>
      /ensureStandardArtifactForSalt|forge build/.test(line)
    )

    expect(gateCallLineIndex(SOURCE)).toBeGreaterThan(-1)
    expect(buildIndex).toBeGreaterThan(-1)
    expect(gateCallLineIndex(SOURCE)).toBeLessThan(buildIndex)
  })

  it('gates outside the retry loop', () => {
    const retryLoopIndex = SOURCE.split('\n').findIndex((line) =>
      line.includes('while [ $attempts -le')
    )

    expect(retryLoopIndex).toBeGreaterThan(-1)
    // Without this the comparison held for a missing call too, at index -1.
    expect(gateCallLineIndex(SOURCE)).toBeGreaterThan(-1)
    expect(gateCallLineIndex(SOURCE)).toBeLessThan(retryLoopIndex)
  })
})

describe('diamondUpdateFacet.sh, which #2324 owns', () => {
  it('is not edited by this change and still routes through the seam', () => {
    const source = readScript('script/tasks/diamondUpdateFacet.sh')

    expect(source).not.toContain(CALL)
    expect(source).toContain('executeAndParse')
  })
})

const SCRIPT_DIRECTORIES = {
  DEPLOY_SCRIPT_DIRECTORY: 'script/deploy/facets/',
  TASKS_SCRIPT_DIRECTORY: 'script/tasks/',
  CONFIG_SCRIPT_DIRECTORY: 'script/tasks/solidity/',
} as const

/**
 * Every entry point EXSC-932 names, with the call that reaches its forge step.
 * `acceptOwnershipTransferPeriphery` is absent: it returns before its forge call
 * for reasons unrelated to this gate, so a case there would assert on a run that
 * never reached it. Its only forge invocation is the `executeAndParse` argument
 * at line 59, so the seam covers it — proven separately, not here.
 */
const DRIVABLE_ENTRY_POINTS = [
  [
    'deploySingleContract',
    'script/deploy/deploySingleContract.sh',
    'deploySingleContract Executor arbitrum staging 1.0.0 false',
  ],
  [
    'deployAndStoreCREATE3Factory',
    'script/deploy/deployAndStoreCREATE3Factory.sh',
    'deployAndStoreCREATE3Factory arbitrum staging',
  ],
  [
    'diamondUpdateFacet',
    'script/tasks/diamondUpdateFacet.sh',
    'diamondUpdateFacet arbitrum staging LiFiDiamond UpdateCoreFacets true',
  ],
  [
    'updateFacetConfig',
    'script/tasks/updateFacetConfig.sh',
    'updateFacetConfig "" staging arbitrum UpdateCoreFacets LiFiDiamond',
  ],
  [
    'checkExecutorAndReceiver',
    'script/tasks/checkExecutorAndReceiver.sh',
    'checkExecutorAndReceiver',
  ],
] as const

/**
 * Runs a real entry-point function with a `forge` stub that records every argv
 * it is called with, so "did a forge start before the gate?" is answered by bash
 * rather than by classifying shell text. Four line-scanning attempts at the same
 * question each missed a different real shape.
 *
 * Scope: the stub is found through PATH, so it records the pinned `forge` only.
 * `./foundry-zksync/forge` is invoked by relative path and is not intercepted.
 *
 * @param sourcePath - Entry-point script to source.
 * @param invocation - The call to make, with arguments.
 * @param forgeVersion - Version the stubbed `forge` reports.
 * @returns Whether the gate refused, and every forge argv observed.
 */
const runEntryPoint = (
  sourcePath: string,
  invocation: string,
  forgeVersion: string
): { refused: boolean; forgeArgv: string[]; touchedRecords: string } => {
  const stubDir = mkdtempSync(join(tmpdir(), 'foundry-version-entry-'))
  const argvLog = join(stubDir, 'argv.log')
  writeFileSync(argvLog, '')

  writeFileSync(
    join(stubDir, 'forge'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${argvLog}\nif [ "$1" = "--version" ]; then\n  echo "forge Version: ${forgeVersion}"\n  echo "Commit SHA: deadbeef"\n  exit 0\nfi\nexit 0\n`
  )
  chmodSync(join(stubDir, 'forge'), 0o755)

  // These entry points prompt for network/diamond/environment.
  writeFileSync(
    join(stubDir, 'gum'),
    `#!/bin/bash\nif [ "$1" = "choose" ]; then\n  echo "2) One specific network (selection in next screen)"\nelse\n  echo "arbitrum"\nfi\n`
  )
  chmodSync(join(stubDir, 'gum'), 0o755)

  const result = spawnSync(
    'bash',
    [
      '-c',
      [
        `PATH="${stubDir}:${pathWithoutForge()}"`,
        `source script/helperFunctions.sh >/dev/null 2>&1`,
        // After the source, not before: helperFunctions.sh reads .env under
        // `set -a`, which overwrites these when the file is present. Without
        // that ordering the retry counts differ between a developer machine and
        // CI, where there is no .env at all.
        `export MAX_ATTEMPTS_PER_SCRIPT_EXECUTION=1`,
        `export MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT=1`,
        `export PRODUCTION=false`,
        // Normally supplied by .env. Without them these scripts cannot resolve
        // their .s.sol path and return before the gate, which made this suite
        // pass locally and fail in CI, where there is no .env.
        ...Object.entries(SCRIPT_DIRECTORIES).map(
          ([name, value]) => `export ${name}="${value}"`
        ),
        // Credential lookups, stubbed so the run reaches the gate on a machine
        // with no keys. Nothing downstream of the gate executes, and the gate
        // itself reads neither.
        `getPrivateKey() { echo "not-a-key"; }`,
        `cast() { echo "0x0000000000000000000000000000000000000001"; }`,
        // diamondUpdateFacet.sh reaches saveDiamondFacets even on its failure
        // path, which rewrites a tracked deployment log. Deployment records are
        // read-only for this project, and the assertion below catches any writer
        // these stubs miss.
        `saveDiamondFacets() { :; }`,
        `saveDiamondPeriphery() { :; }`,
        `source ${sourcePath} >/dev/null 2>&1`,
        invocation,
      ].join('\n'),
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )

  return {
    refused: `${result.stdout}${result.stderr}`.includes(
      'Cannot confirm the local foundry'
    ),
    forgeArgv: readFileSync(argvLog, 'utf8')
      .split('\n')
      .filter((argv) => argv !== ''),
    // Driving real deploy scripts must not rewrite the repo's own records.
    touchedRecords: execFileSync(
      'git',
      ['status', '--porcelain', 'deployments', 'config'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    ).trim(),
  }
}

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

describe('every drivable entry point, driven for real', () => {
  it.each(Object.entries(SCRIPT_DIRECTORIES))(
    'stands in for %s exactly as .env.example defines it',
    (name, value) => {
      // These are hardcoded so the harness works without a .env. If the
      // template moves a directory, the harness must move with it rather than
      // silently stop reaching the gate.
      expect(readScript('.env.example')).toContain(`${name}="${value}"`)
    }
  )

  it.each(DRIVABLE_ENTRY_POINTS)(
    '%s refuses a drifted forge and starts no other forge',
    (_name, sourcePath, invocation) => {
      const { refused, forgeArgv, touchedRecords } = runEntryPoint(
        sourcePath,
        invocation,
        '9.9.9'
      )

      expect(touchedRecords).toBe('')
      expect(refused).toBe(true)
      // Non-empty proves the run actually reached the gate rather than
      // returning early, which would satisfy the next assertion for free.
      expect(forgeArgv.length).toBeGreaterThan(0)
      // The checker's own probe is the only forge allowed to run.
      expect(forgeArgv.filter((argv) => argv !== '--version')).toEqual([])
    },
    30_000
  )

  it('observes a non-probe forge when one does run', () => {
    // The control for the assertion above: it would also pass against a stub
    // that could never record anything.
    const { forgeArgv } = runEntryPoint(
      'script/deploy/deploySingleContract.sh',
      'forge build --skip test',
      '9.9.9'
    )

    expect(forgeArgv).toContain('build --skip test')
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
    const source = readScript('script/deploy/deploySingleContract.sh')
    const guard = source.split('\n').slice(gateCallLineIndex(source))
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
