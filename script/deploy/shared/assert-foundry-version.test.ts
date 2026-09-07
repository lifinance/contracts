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
 * Splits a script into lines, replacing every line that bash would not execute
 * — comments, and lines sitting inside a multi-line double-quoted string — with
 * null.
 *
 * The string tracking matters: a heredoc-ish `NOTE="\n...\n"` block let a line
 * that merely *names* the gate count as a call to it, which is the same vacuity
 * the comment exclusion was added to close.
 *
 * @param source - Whole file contents.
 * @returns One entry per line, null where nothing executes.
 */
const executableLines = (source: string): (string | null)[] => {
  let insideString = false

  return source.split('\n').map((line) => {
    const startedInsideString = insideString
    const quotes = line.match(/(?<!\\)"/g)
    if (quotes !== null && quotes.length % 2 === 1) insideString = !insideString

    if (startedInsideString) return null
    return line.trimStart().startsWith('#') ? null : line
  })
}

/**
 * Command-position fragments of one line: what bash would run first, plus every
 * position a separator opens a fresh command in.
 *
 * Position 0 alone was not enough — `cd x; forge build`, `a && forge build` and
 * `eval "forge build"` all start a forge and all hid from a position-0 match.
 *
 * @param line - A single executable line of a shell script.
 * @returns Every fragment that begins at a command position.
 */
const FUNCTION_DEFINITION =
  /^\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{?\s*$/

const commandPositionsOf = (line: string): string[] => {
  if (FUNCTION_DEFINITION.test(line)) return []

  // `eval "cmd"` runs cmd, so unwrap it before anything else. Doing it by
  // stripping a leading quote per fragment instead would also unwrap the quoted
  // COMMAND strings that are handed to the seam, which are not invocations.
  let rest = line
    .replace(/\beval\s+"([^"]*)"/g, ' $1 ')
    .replace(/'[^']*'/g, "''")

  // Command substitutions run their contents, so they are their own command
  // positions; a placeholder then keeps `VAR=$(…) cmd` parseable as one
  // assignment rather than splitting mid-expression.
  const substitutions: string[] = []
  const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/
  for (let match = SUBSTITUTION.exec(rest); match !== null; ) {
    substitutions.push(match[1] ?? match[2] ?? '')
    rest = rest.replace(SUBSTITUTION, 'SUBSTITUTION')
    match = SUBSTITUTION.exec(rest)
  }

  const fragments = rest
    .split(/;|&&|\|\||\||\bdo\b|\bthen\b|\{|\(|\)/)
    .map((fragment) => {
      let candidate = fragment.trim()

      let changed = true
      while (changed) {
        changed = false
        for (const prefix of [
          'if ',
          'elif ',
          'while ',
          'until ',
          '! ',
          'command ',
          'env ',
          'nohup ',
          'time ',
        ]) {
          if (candidate.startsWith(prefix)) {
            candidate = candidate.slice(prefix.length).trimStart()
            changed = true
          }
        }
        // The unquoted alternative deliberately excludes quotes: letting it
        // consume a half-open `VAR="word` turned the rest of a quoted COMMAND
        // string into an apparent command position.
        const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|''|[^\s"']*)\s+/
        if (assignment.test(candidate)) {
          candidate = candidate.replace(assignment, '')
          changed = true
        }
      }

      return candidate
    })

  return [...fragments, ...substitutions.flatMap(commandPositionsOf)].filter(
    (fragment) => fragment !== ''
  )
}

/**
 * Reduces a line to what bash would run first.
 *
 * @param line - A single line of a shell script.
 * @returns The command-position remainder, or an empty string for a comment.
 */
const commandPositionOf = (line: string): string =>
  line.trimStart().startsWith('#') ? '' : commandPositionsOf(line)[0] ?? ''

/**
 * True when the line starts a forge process — either the PATH `forge` the pin
 * governs, or the separately pinned `./foundry-zksync/forge` fork — rather than
 * mentioning one inside a string that is handed to the seam.
 *
 * @param line - A single line of a shell script.
 * @returns Whether a forge process would be started by this line.
 */
const invokesForgeDirectly = (line: string): boolean =>
  line.trimStart().startsWith('#')
    ? false
    : commandPositionsOf(line).some((fragment) =>
        /^(?:\.\/foundry-zksync\/)?forge\s/.test(fragment)
      )

/**
 * Index of the first line that actually *calls* the gate — the seam function
 * itself, or `executeAndParse`, which calls it. A mention inside a comment does
 * not count: the placement assertions were vacuous while it did, and passed with
 * the gate deleted and the comment left behind.
 *
 * @param lines - Lines of a shell script.
 * @returns The line index, or -1 when the file never calls the gate.
 */
const callsAtCommandPosition = (
  line: string | null,
  names: string[]
): boolean =>
  line === null
    ? false
    : commandPositionsOf(line).some((fragment) =>
        names.some((name) =>
          // `name(` is a function definition, not a call to it.
          new RegExp(`^${name}(?:\\s|$)`).test(fragment)
        )
      )

const firstGateCallIndex = (source: string): number =>
  executableLines(source).findIndex((line) =>
    callsAtCommandPosition(line, [CALL, 'executeAndParse'])
  )

/**
 * Index of the first line that calls the seam function itself, ignoring
 * comments and string bodies that merely name it.
 *
 * @param source - Whole file contents.
 * @returns The line index, or -1 when the file never calls it.
 */
const firstSeamCallIndex = (source: string): number =>
  executableLines(source).findIndex((line) =>
    callsAtCommandPosition(line, [CALL])
  )

/**
 * Index of the first line that starts a forge process.
 *
 * @param source - Whole file contents.
 * @returns The line index, or -1 when the file starts none.
 */
const firstDirectForgeIndex = (source: string): number =>
  executableLines(source).findIndex(
    (line) => line !== null && invokesForgeDirectly(line)
  )

describe('invokesForgeDirectly', () => {
  it.each([
    ['forge build'],
    ['  forge build --skip test'],
    ['if ! forge build --contracts x --silent; then'],
    ['FOUNDRY_PROFILE=zksync ./foundry-zksync/forge build --zksync'],
    ['PRIVATE_KEY="$KEY" forge script X.s.sol'],
    // Every shape below started a forge while hiding from a position-0 match,
    // and four of them kept the placement suite green with the gate removed.
    ['cd "$(pwd)"; forge build --skip test'],
    ['[ -d out ] || forge build --skip test'],
    ['make deps && forge build'],
    ['eval "FOUNDRY_PROFILE=zksync ./foundry-zksync/forge build --zksync"'],
    ['PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script X'],
    ['{ forge build; }'],
    ['(forge build)'],
    ['do forge build'],
    ['command forge build'],
    ['time forge build'],
    ['if [[ -z x ]]; then forge build; fi'],
    ['OUT=$(forge build)'],
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
    ['  if ! assertFoundryVersionOrFail; then'],
    ['  assertFoundryVersionOrFail || return 1'],
    ['  executeAndParse \\'],
    ['      if ! executeAndParse \\'],
    ['  RESULT=$(executeAndParse "cmd")'],
    ['  { executeAndParse \\'],
  ])('finds the call in %p', (source) => {
    expect(firstGateCallIndex(source)).toBe(0)
  })

  it.each([
    ['  # Also checked at the shared executeAndParse seam, but the zk path'],
    ['  # if ! assertFoundryVersionOrFail; then'],
    ['  echo "executeAndParse runs the command"'],
    // The function definition is not a call to it.
    ['function executeAndParse() {'],
    ['executeAndParse() {'],
  ])('does not count %p as a call', (source) => {
    expect(firstGateCallIndex(source)).toBe(-1)
  })

  it('does not count a line inside a multi-line string', () => {
    // This exact shape removed the gate from an entry point and kept the whole
    // placement suite green.
    const source = [
      'NOTE="',
      'executeAndParse used to run this, see history',
      '"',
      '    executeAndCapture \\',
    ].join('\n')

    expect(firstGateCallIndex(source)).toBe(-1)
  })

  it('still finds a real call after a multi-line string closes', () => {
    // The counterpart: without it, a helper that called every line "inside a
    // string" would pass the case above.
    const source = [
      'NOTE="',
      'executeAndParse used to run this, see history',
      '"',
      '    executeAndParse \\',
    ].join('\n')

    expect(firstGateCallIndex(source)).toBe(3)
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
    const callIndex = firstSeamCallIndex(lines.slice(functionIndex).join('\n'))
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
    // Guards the assertions below against the case where they hold because the
    // file stopped being a forge entry point. Error-message strings such as
    // "forge script failed for …" appear in most of these files, so a bare
    // regex over the whole source would have satisfied this on a file that no
    // longer invokes forge at all.
    const drives = executableLines(readScript(relativePath)).some(
      (line) => line !== null && /forge\s+(?:script|build)\b/.test(line)
    )

    expect(drives).toBe(true)
  })

  it.each(ENTRY_POINTS)('%s calls the gate', (relativePath) => {
    expect(firstGateCallIndex(readScript(relativePath))).toBeGreaterThan(-1)
  })

  it.each(ENTRY_POINTS)(
    '%s cannot start a forge before the gate has run',
    (relativePath) => {
      const source = readScript(relativePath)
      const directForgeIndex = firstDirectForgeIndex(source)

      // Infinity rather than a conditional assertion: a file with no
      // command-position forge has nothing to order against, but the comparison
      // must still fail when the gate call is missing entirely (index -1).
      expect(firstGateCallIndex(source)).toBeLessThan(
        directForgeIndex === -1 ? Number.POSITIVE_INFINITY : directForgeIndex
      )
      expect(firstGateCallIndex(source)).toBeGreaterThan(-1)
    }
  )

  it('leaves diamondUpdateFacet.sh unedited, covered through the seam', () => {
    // lifinance/contracts#2324 is open against this file. It reaches the gate
    // because its forge invocations are strings handed to executeAndParse.
    const source = readScript('script/tasks/diamondUpdateFacet.sh')
    expect(source).not.toContain(CALL)
    expect(firstGateCallIndex(source)).toBeGreaterThan(-1)
    expect(firstDirectForgeIndex(source)).toBe(-1)
  })

  it('gates deploySingleContract before its own build steps', () => {
    // Its zk path builds and derives the CREATE2 salt through
    // `ensureStandardArtifactForSalt`, both of which start a forge before the
    // first executeAndParse. The seam alone would fire too late here.
    const source = readScript('script/deploy/deploySingleContract.sh')
    const lines = source.split('\n')
    const callIndex = firstSeamCallIndex(source)
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
    const source = readScript('script/deploy/deploySingleContract.sh')
    const callIndex = firstSeamCallIndex(source)
    const retryLoopIndex = source
      .split('\n')
      .findIndex((line) => line.includes('while [ $attempts -le'))

    expect(retryLoopIndex).toBeGreaterThan(-1)
    // Without this the comparison held for a missing call too, at index -1.
    expect(callIndex).toBeGreaterThan(-1)
    expect(callIndex).toBeLessThan(retryLoopIndex)
  })
})

/**
 * Every entry point that can be driven to its gate without a real signing key.
 * `deployAndStoreCREATE3Factory` and `acceptOwnershipTransferPeriphery` cannot:
 * both read a private key out of `.env` and return before their forge call when
 * it is absent, so an executable case there would assert on a run that never
 * reached the gate. They keep the static assertions above.
 */
const DRIVABLE_ENTRY_POINTS = [
  [
    'deploySingleContract',
    'script/deploy/deploySingleContract.sh',
    'deploySingleContract Executor arbitrum staging 1.0.0 false',
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
 * rather than by a line scanner. The line scanners above missed `cd x; forge`,
 * `a && forge` and `eval "forge …"`; this cannot.
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
): { refused: boolean; forgeArgv: string[] } => {
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
  it.each(DRIVABLE_ENTRY_POINTS)(
    '%s refuses a drifted forge and starts no other forge',
    (_name, sourcePath, invocation) => {
      const { refused, forgeArgv } = runEntryPoint(
        sourcePath,
        invocation,
        '9.9.9'
      )

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
    const guard = source.split('\n').slice(firstSeamCallIndex(source))
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
