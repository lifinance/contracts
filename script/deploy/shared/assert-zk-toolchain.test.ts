/**
 * Covers the zkEVM toolchain pre-flight: the checker's verdicts, the bash seam's
 * fail-closed behaviour, and where the gate sits relative to the zk build.
 *
 * Placement is answered by running `script/deploy/deployContractToNetworks.sh` for real
 * against a `./foundry-zksync/forge` that records every argv it is handed, so "did a zk
 * build start?" is answered by bash. Classifying shell text to answer the same question was
 * wrong four times on the EVM counterpart.
 *
 * Every case runs in a throwaway tree whose `foundry-zksync/`, `.env` and `foundry.toml` are
 * its own, so no case can touch the checkout's toolchain or read its secrets, and `curl` and
 * `wget` are stubbed to fail so the installer can never reach the network.
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
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
const SEAM = 'script/deploy/shared/assertZkToolchain.sh'
const CHECKER = 'script/utils/verify-zk-toolchain.sh'
const PIN_READER = 'script/utils/zkToolchainPins.sh'
const CALL = 'assertZkToolchainOrFail'

const REFUSAL = 'Cannot confirm the zkEVM toolchain matches the pins'
const ZK_BUILD_ARGV = 'build --zksync --skip test'

const FOUNDRY_TOML = readFileSync(join(REPO_ROOT, 'foundry.toml'), 'utf8')

/**
 * Reads a pin out of the checkout's own foundry.toml, so no expected value in this file is
 * a second copy of a number that lives in the repo.
 *
 * @param key - Pin name inside `[external.zksync]`.
 * @returns The pinned value.
 */
const pin = (key: string): string => {
  const section = FOUNDRY_TOML.split('[external.zksync]')[1] ?? ''
  const value = (section.split(/\n\[/)[0] ?? '').match(
    new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`, 'm')
  )?.[1]
  if (value === undefined) throw new Error(`no ${key} pin in foundry.toml`)
  return value
}

const ZKSOLC_PIN = pin('zksolc')
const ZK_FOUNDRY_PIN = pin('foundry_zksync')

/** A `.env` the deploy scripts accept, holding only path settings and no credentials. */
const HARMLESS_ENV = [
  'PRODUCTION=false',
  'CONTRACT_DIRECTORY="src/"',
  'DEPLOY_SCRIPT_DIRECTORY="script/deploy/facets/"',
  'TASKS_SCRIPT_DIRECTORY="script/tasks/"',
  'CONFIG_SCRIPT_DIRECTORY="script/tasks/solidity/"',
  'TARGET_STATE_PATH="script/deploy/_targetState.json"',
  'LOG_FILE_PATH="deployments/_deployments_log_file.json"',
  'BYTECODE_STORAGE_PATH="deployments/_bytecode_storage.json"',
  'DEPLOY_REQUIREMENTS_PATH="script/deploy/resources/deployRequirements.json"',
  'DEPLOY_CONFIG_FILE_PATH="config/"',
  'FOUNDRY_TOML_FILE_PATH="foundry.toml"',
  'MAX_ATTEMPTS_PER_SCRIPT_EXECUTION=1',
  'MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT=1',
  'MAX_CONCURRENT_JOBS=1',
  'SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=false',
  'COMPILE_ON_STARTUP=false',
  '',
].join('\n')

/** A contract the grouping code can resolve a version for, deployed to a zkEVM network. */
const DRIVE_CONTRACT = 'Executor'
const DRIVE_CONTRACT_SOURCE = 'src/Periphery/Executor.sol'
const DRIVE_NETWORK = 'abstract'

interface IFarm {
  /** Root the scripts are run from. */
  root: string
  /** Every argv the stubbed binaries were handed, in order. */
  argv: () => string[]
  /** Current text of the farm's foundry.toml. */
  foundryToml: () => string
}

/**
 * Writes an executable stub that appends its argv to a log.
 *
 * @param path - Where to write it.
 * @param label - Prefix each logged line carries, so callers can tell the stubs apart.
 * @param log - Argv log path.
 * @param versionOutput - Printed for `--version`; omit to make every call a no-op success.
 * @param exitCode - Status for calls other than `--version`.
 */
const writeStub = (
  path: string,
  label: string,
  log: string,
  versionOutput?: string,
  exitCode = 0
): void => {
  const versionBranch =
    versionOutput === undefined
      ? ''
      : `if [ "$1" = "--version" ]; then\n${versionOutput
          .split('\n')
          .map((line) => `  echo "${line}"`)
          .join('\n')}\n  exit 0\nfi\n`
  writeFileSync(
    path,
    `#!/bin/bash\nprintf '${label} %s\\n' "$*" >> ${log}\n${versionBranch}exit ${exitCode}\n`
  )
  chmodSync(path, 0o755)
}

/**
 * Builds a throwaway tree the deploy scripts can run in: the repo's script/config/lib
 * directories are shared by symlink, while `foundry-zksync/`, `foundry.toml`, `.env` and the
 * one source file the drive needs are the farm's own, so a case can drift them freely.
 *
 * `src/` is a real directory holding a symlink to the one contract, because
 * `getContractFilePath` runs `find src` without `-L` and would not descend into a symlinked
 * directory.
 *
 * @param options.zkForgeVersion - Version the stubbed `./foundry-zksync/forge` reports.
 * Omit to leave the install directory empty.
 * @param options.foundryToml - Replacement foundry.toml text.
 * @param options.env - Extra `.env` lines. These have to go in the file rather than in the
 * child's environment: the scripts read `.env` under `set -a` inside their own body, which
 * overwrites anything exported beforehand.
 * @returns Handles on the farm.
 */
const makeFarm = (options?: {
  zkForgeVersion?: string
  foundryToml?: string
  env?: string[]
}): IFarm => {
  const root = mkdtempSync(join(tmpdir(), 'zk-toolchain-farm-'))
  const log = join(root, 'argv.log')
  writeFileSync(log, '')

  for (const entry of ['script', 'config', 'lib', 'out'])
    if (existsSync(join(REPO_ROOT, entry)))
      symlinkSync(join(REPO_ROOT, entry), join(root, entry))
  // A copy, not a symlink: the drives below write deployment records, and a symlink would
  // land them in the checkout. One case did exactly that before this was changed.
  cpSync(join(REPO_ROOT, 'deployments'), join(root, 'deployments'), {
    recursive: true,
  })
  for (const entry of ['remappings.txt', '.foundry-version'])
    copyFileSync(join(REPO_ROOT, entry), join(root, entry))

  writeFileSync(
    join(root, 'foundry.toml'),
    options?.foundryToml ?? FOUNDRY_TOML
  )
  writeFileSync(
    join(root, '.env'),
    [HARMLESS_ENV, ...(options?.env ?? []), ''].join('\n')
  )

  mkdirSync(join(root, 'src', 'Periphery'), { recursive: true })
  symlinkSync(
    join(REPO_ROOT, DRIVE_CONTRACT_SOURCE),
    join(root, 'src', 'Periphery', `${DRIVE_CONTRACT}.sol`)
  )

  mkdirSync(join(root, 'foundry-zksync'))
  if (options?.zkForgeVersion !== undefined)
    for (const binary of ['forge', 'cast'])
      writeStub(
        join(root, 'foundry-zksync', binary),
        `zk-${binary}`,
        log,
        `forge Version: 1.6.0\nfoundry-zksync-${options.zkForgeVersion}`
      )

  // Every binary that could reach the network or a chain, stubbed inert. `forge` reports the
  // pinned version so the EVM gate is not what refuses in these cases.
  mkdirSync(join(root, 'bin'))
  writeStub(
    join(root, 'bin', 'forge'),
    'forge',
    log,
    `forge Version: ${readFileSync(
      join(REPO_ROOT, '.foundry-version'),
      'utf8'
    ).trim()}`
  )
  for (const binary of ['cast', 'bun', 'bunx', 'curl', 'wget'])
    writeStub(join(root, 'bin', binary), binary, log, undefined, 1)

  return {
    root,
    argv: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
    foundryToml: () => readFileSync(join(root, 'foundry.toml'), 'utf8'),
  }
}

/**
 * Runs a bash snippet inside a farm, with the farm's stub directory first on PATH.
 *
 * @param farm - Farm to run in.
 * @param lines - Snippet lines.
 * @param environment - Extra environment for the child.
 * @returns Everything the snippet printed.
 */
const runInFarm = (
  farm: IFarm,
  lines: string[],
  environment: Record<string, string> = {}
): string => {
  const result = spawnSync('bash', ['-c', lines.join('\n')], {
    cwd: farm.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...environment,
      PATH: `${join(farm.root, 'bin')}:${process.env.PATH ?? ''}`,
    },
  })
  return `${result.stdout}${result.stderr}`
}

/**
 * Runs the real bash seam in a farm.
 *
 * @param farm - Farm to run in.
 * @param environment - Extra environment, e.g. a tampered `FOUNDRY_ZKSYNC`.
 * @param sourcePins - Whether to source the pin reader, which is what exports
 * `FOUNDRY_ZKSYNC` on the real deploy path.
 * @returns The seam's output plus its own `SEAM_RC=` line.
 */
const runSeam = (
  farm: IFarm,
  environment: Record<string, string> = {},
  sourcePins = true
): string =>
  runInFarm(
    farm,
    [
      `error() { echo "ERROR:$*"; }`,
      ...(sourcePins
        ? [
            `source ${PIN_READER}`,
            `ZKSOLC_VERSION=$(getZkToolchainPin zksolc)`,
            `if [[ -n "$ZKSOLC_VERSION" ]]; then export FOUNDRY_ZKSYNC="{ zksolc = \\"$ZKSOLC_VERSION\\" }"; fi`,
          ]
        : []),
      `source ${SEAM}`,
      CALL,
      `echo "SEAM_RC=$?"`,
    ],
    environment
  )

describe('verify-zk-toolchain.sh — the checker', () => {
  it('passes, and prints the pair it confirmed, when both pins hold', () => {
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })

    const output = runInFarm(farm, [
      `source ${PIN_READER}`,
      `export FOUNDRY_ZKSYNC="{ zksolc = \\"$(getZkToolchainPin zksolc)\\" }"`,
      `bash ${CHECKER}`,
      `echo "CHECKER_RC=$?"`,
    ])

    expect(output).toContain('CHECKER_RC=0')
    expect(output).toContain(ZK_FOUNDRY_PIN)
    expect(output).toContain(ZKSOLC_PIN)
  })

  it('refuses when the zksolc pin is gone from foundry.toml', () => {
    // The pin's absence is the reason FOUNDRY_ZKSYNC ends up unset on the deploy path: the
    // export is conditional on a non-empty pin, so a lost pin silently fell back to
    // whatever zksolc the binary defaults to.
    const farm = makeFarm({
      zkForgeVersion: ZK_FOUNDRY_PIN,
      foundryToml: FOUNDRY_TOML.replace(/^zksolc = .*$/m, ''),
    })

    const output = runSeam(farm)

    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('zk toolchain pins missing')
    expect(output).toContain(REFUSAL)
  })

  it('refuses when FOUNDRY_ZKSYNC names a different zksolc than the pin', () => {
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })

    // sourcePins off: the pin reader is what exports FOUNDRY_ZKSYNC, and letting it run
    // would overwrite the tampered value this case is about.
    const output = runSeam(
      farm,
      { FOUNDRY_ZKSYNC: '{ zksolc = "0.0.1" }' },
      false
    )

    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('does not name the pinned zksolc')
    expect(output).toContain(ZKSOLC_PIN)
  })

  it('refuses a zksolc whose version merely starts with the pin', () => {
    // The comparison was a bare substring test, so pin 1.5.15 accepted a 1.5.155
    // toolchain — a false green in the one check that decides the compiler is the
    // pinned one. Anchored on the value's closing quote now.
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })

    const output = runSeam(
      farm,
      { FOUNDRY_ZKSYNC: `{ zksolc = "${ZKSOLC_PIN}5" }` },
      false
    )

    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('does not name the pinned zksolc')
  })

  it('still accepts the exact pin, so the anchoring is not blanket', () => {
    // The paired positive: an anchor that refused everything would satisfy the case
    // above while disabling the gate.
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })

    const output = runSeam(
      farm,
      { FOUNDRY_ZKSYNC: `{ zksolc = "${ZKSOLC_PIN}" }` },
      false
    )

    expect(output).toContain('SEAM_RC=0')
  })

  it('refuses when FOUNDRY_ZKSYNC is not exported, because zksolc is then unpinned', () => {
    // The only mechanism pinning zksolc is that env var, so an unset value means the
    // toolchain picks its own default - which is what a lost pin silently produced.
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })

    const output = runSeam(farm, { FOUNDRY_ZKSYNC: '' }, false)

    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('zksolc is unpinned')
    expect(output).toContain(ZKSOLC_PIN)
  })

  it('refuses when FOUNDRY_ZKSYNC_VERSION diverges from the committed pin', () => {
    // The one shape the pre-existing installer cannot catch: it compares the binary against
    // the override, so an override plus a matching binary read as a clean install.
    const farm = makeFarm({ zkForgeVersion: 'v9.9.9' })

    const output = runSeam(farm, { FOUNDRY_ZKSYNC_VERSION: 'v9.9.9' })

    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('overrides the committed foundry-zksync pin')
    expect(output).toContain(ZK_FOUNDRY_PIN)
  })

  it('refuses when the installed foundry-zksync is a different release', () => {
    const farm = makeFarm({ zkForgeVersion: 'v9.9.9' })

    const output = runSeam(farm)

    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('foundry-zksync version mismatch')
    expect(output).toContain('v9.9.9')
  })

  it('refuses when there is no foundry-zksync binary at all', () => {
    const farm = makeFarm()

    const output = runSeam(farm)

    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('no executable foundry-zksync forge')
  })

  it('refuses when the binary answers --version with nothing parseable', () => {
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })
    writeFileSync(
      join(farm.root, 'foundry-zksync', 'forge'),
      '#!/bin/bash\necho "who knows"\nexit 0\n'
    )
    chmodSync(join(farm.root, 'foundry-zksync', 'forge'), 0o755)

    const output = runSeam(farm)

    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('could not parse the foundry-zksync version')
  })
})

describe('assertZkToolchainOrFail — the bash seam fails closed', () => {
  /**
   * Builds a tree that looks like a checkout to the seam, so the "checker cannot run" cases
   * are driven rather than argued.
   *
   * @param include - Which of the seam's two dependencies to place in it.
   * @returns Path to the tree.
   */
  const treeWith = (include: {
    checker: boolean
    pinReader: boolean
  }): string => {
    const root = mkdtempSync(join(tmpdir(), 'zk-toolchain-root-'))
    mkdirSync(join(root, 'script', 'utils'), { recursive: true })
    copyFileSync(join(REPO_ROOT, 'foundry.toml'), join(root, 'foundry.toml'))
    if (include.checker)
      copyFileSync(join(REPO_ROOT, CHECKER), join(root, CHECKER))
    if (include.pinReader)
      copyFileSync(join(REPO_ROOT, PIN_READER), join(root, PIN_READER))
    return root
  }

  /**
   * Runs the seam with its checker lookup pointed at a chosen tree, and a matching zk
   * binary inside that tree so only the missing dependency can be what refuses.
   *
   * @param root - Tree to run in.
   * @returns The seam's output plus its `SEAM_RC=` line.
   */
  const runSeamIn = (root: string): string => {
    mkdirSync(join(root, 'foundry-zksync'), { recursive: true })
    const log = join(root, 'argv.log')
    writeFileSync(log, '')
    writeStub(
      join(root, 'foundry-zksync', 'forge'),
      'zk-forge',
      log,
      `forge Version: 1.6.0\nfoundry-zksync-${ZK_FOUNDRY_PIN}`
    )

    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          `error() { echo "ERROR:$*"; }`,
          `export FOUNDRY_ZKSYNC='{ zksolc = "${ZKSOLC_PIN}" }'`,
          `source ${join(REPO_ROOT, SEAM)}`,
          CALL,
          `echo "SEAM_RC=$?"`,
        ].join('\n'),
      ],
      { cwd: root, encoding: 'utf8' }
    )
    return `${result.stdout}${result.stderr}`
  }

  it('refuses when the checker is not in the tree', () => {
    const output = runSeamIn(treeWith({ checker: false, pinReader: true }))

    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain('zk toolchain checker not found')
  })

  it('passes in the same tree once the checker is restored', () => {
    // Without this counterpart the case above would pass against a seam that refuses
    // everything, including a healthy toolchain.
    const output = runSeamIn(treeWith({ checker: true, pinReader: true }))

    expect(output).toContain('SEAM_RC=0')
    expect(output).not.toContain(REFUSAL)
  })

  it('refuses when the checker is there but cannot run', () => {
    const output = runSeamIn(treeWith({ checker: true, pinReader: false }))

    expect(output).toContain('SEAM_RC=1')
    expect(output).toContain(REFUSAL)
  })
})

describe('the placement, driven through the real deploy CLI', () => {
  /**
   * Runs `deployContractToNetworks.sh` for one zkEVM network, which is the shortest real
   * path to a zk build: with no london or cancun network in the set, the zkEVM wave is the
   * first thing that builds.
   *
   * @param farm - Farm to run in.
   * @param environment - Extra environment for the child.
   * @returns The run's output.
   */
  const driveDeployCli = (
    farm: IFarm,
    environment: Record<string, string> = {}
  ): string =>
    runInFarm(
      farm,
      [
        `bash script/deploy/deployContractToNetworks.sh ${DRIVE_CONTRACT} ${DRIVE_NETWORK}`,
      ],
      environment
    )

  it('refuses before any zk build starts', () => {
    const farm = makeFarm({ zkForgeVersion: 'v9.9.9' })

    const output = driveDeployCli(farm, { FOUNDRY_ZKSYNC_VERSION: 'v9.9.9' })

    expect(output).toContain(REFUSAL)
    // The installer's own comparison is satisfied here, so without the gate this run
    // proceeds to build.
    expect(output).toContain('Version matches expected v9.9.9')
    expect(farm.argv().some((argv) => argv.includes(ZK_BUILD_ARGV))).toBe(false)
    // Paired with the absence above: a run that never reached the installer would also
    // record no build, and would prove nothing.
    expect(
      farm.argv().some((argv) => argv.includes('zk-forge --version'))
    ).toBe(true)
    expect(output).toContain('aborting before deploying any zkEVM network')
  })

  it('stays silent and lets the zk build run when the toolchain is pinned', () => {
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })

    const output = driveDeployCli(farm)

    expect(output).not.toContain(REFUSAL)
    expect(farm.argv().some((argv) => argv.includes(ZK_BUILD_ARGV))).toBe(true)
  })
})

describe('install_foundry_zksync is the chokepoint every zk build passes', () => {
  /**
   * Every shell script under `script/`, found rather than listed.
   * @param relative - directory to walk, relative to the repo root
   * @returns Repo-relative paths of every `.sh` file beneath it
   */
  const shellScripts = (relative = 'script'): string[] =>
    readdirSync(join(REPO_ROOT, relative), { withFileTypes: true }).flatMap(
      (entry) =>
        entry.isDirectory()
          ? shellScripts(`${relative}/${entry.name}`)
          : entry.name.endsWith('.sh')
          ? [`${relative}/${entry.name}`]
          : []
    )

  it('is called by every script that reaches for the zk forge', () => {
    // Discovered, not enumerated. A hardcoded list only catches a new call site added to
    // one of the files already on it — a brand-new script reaching for the zk forge was
    // invisible to it, which is the gap the list was supposed to close.
    const scripts = shellScripts().map((path) => ({
      path,
      source: readFileSync(join(REPO_ROOT, path), 'utf8'),
    }))

    const reachingForZkForge = scripts.filter((file) =>
      file.source.includes('foundry-zksync/forge')
    )
    const ungated = reachingForZkForge.filter(
      (file) => !file.source.includes('install_foundry_zksync')
    )

    // Paired: without this, a walk that found nothing would pass while checking nothing.
    expect(reachingForZkForge.length).toBeGreaterThan(0)
    expect(ungated.map((file) => file.path)).toEqual([])
  })

  it('refuses every caller, because the check is inside it rather than beside it', () => {
    const farm = makeFarm({ zkForgeVersion: 'v9.9.9' })

    const output = runInFarm(
      farm,
      [
        `source script/helperFunctions.sh >/dev/null 2>&1`,
        `install_foundry_zksync >/dev/null`,
        `echo "INSTALL_RC=$?"`,
      ],
      { FOUNDRY_ZKSYNC_VERSION: 'v9.9.9' }
    )

    expect(output).toContain('INSTALL_RC=1')
  })

  it('stops diamondUpdateFacet, whose call site used to ignore the status', () => {
    // Two call sites called the installer bare, so its verdict was discarded and the zk
    // forge script ran anyway. Driven rather than read: gum is stubbed so the prompts the
    // function reaches after the gate do not block.
    const farm = makeFarm({ zkForgeVersion: 'v9.9.9' })
    writeStub(join(farm.root, 'bin', 'gum'), 'gum', join(farm.root, 'argv.log'))

    const output = runInFarm(
      farm,
      [
        `source script/helperFunctions.sh >/dev/null 2>&1`,
        `source script/tasks/diamondUpdateFacet.sh >/dev/null 2>&1`,
        `diamondUpdateFacet ${DRIVE_NETWORK} staging LiFiDiamond UpdateCoreFacets true`,
        `echo "UPDATE_RC=$?"`,
      ],
      { FOUNDRY_ZKSYNC_VERSION: 'v9.9.9' }
    )

    expect(output).toContain('UPDATE_RC=1')
    expect(output).toContain(REFUSAL)
    expect(output).toContain('Version matches expected v9.9.9')
    expect(farm.argv().some((argv) => argv.includes('forge script'))).toBe(
      false
    )
    expect(
      farm.argv().some((argv) => argv.includes('zk-forge --version'))
    ).toBe(true)
  })

  it('returns 0 for a pinned toolchain, so the refusal is not unconditional', () => {
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })

    const output = runInFarm(farm, [
      `source script/helperFunctions.sh >/dev/null 2>&1`,
      `install_foundry_zksync >/dev/null`,
      `echo "INSTALL_RC=$?"`,
    ])

    expect(output).toContain('INSTALL_RC=0')
  })
})

describe('the ungated forge build sites', () => {
  it('refuses the per-group build before foundry.toml is rewritten', () => {
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })
    writeStub(
      join(farm.root, 'bin', 'forge'),
      'forge',
      join(farm.root, 'argv.log'),
      'forge Version: 0.0.1'
    )
    const before = farm.foundryToml()

    const output = runInFarm(farm, [
      `source script/helperFunctions.sh >/dev/null 2>&1`,
      `source script/deploy/resources/deployGroupingHelpers.sh`,
      `updateFoundryTomlForGroup "$GROUP_LONDON" true`,
      `echo "GROUP_RC=$?"`,
    ])

    expect(output).toContain('GROUP_RC=1')
    expect(output).toContain('Cannot confirm the local foundry')
    expect(farm.argv().some((argv) => argv.startsWith('forge build'))).toBe(
      false
    )
    // A refusal that had already rewritten the profile would leave the checkout pointed at
    // a group whose build never ran.
    expect(farm.foundryToml()).toBe(before)
  })

  it('rewrites foundry.toml and builds once the forge matches', () => {
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })
    const before = farm.foundryToml()

    const output = runInFarm(farm, [
      `source script/helperFunctions.sh >/dev/null 2>&1`,
      `source script/deploy/resources/deployGroupingHelpers.sh`,
      `updateFoundryTomlForGroup "$GROUP_LONDON" true`,
      `echo "GROUP_RC=$?"`,
    ])

    expect(output).toContain('GROUP_RC=0')
    expect(farm.argv().some((argv) => argv.startsWith('forge build'))).toBe(
      true
    )
    expect(farm.foundryToml()).not.toBe(before)
  })

  it('leaves the tolerant group path tolerant, as #2325 decided', () => {
    // updateFoundryTomlForGroup's default mode swallows build failures for the
    // playground runner, and multiNetworkExecution.sh's two callers rely on that
    // return contract. Refusing here would abort a whole multi-network group on a
    // mismatch the per-network gate in deploySingleContract refuses anyway, which is
    // the behaviour change #2325 examined and declined to make.
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })
    writeStub(
      join(farm.root, 'bin', 'forge'),
      'forge',
      join(farm.root, 'argv.log'),
      'forge Version: 0.0.1'
    )

    const output = runInFarm(farm, [
      `source script/helperFunctions.sh >/dev/null 2>&1`,
      `source script/deploy/resources/deployGroupingHelpers.sh`,
      `updateFoundryTomlForGroup "$GROUP_LONDON"`,
      `echo "GROUP_RC=$?"`,
    ])

    expect(output).toContain('GROUP_RC=0')
  })

  it('refuses the deploy-salt build before it starts a forge', () => {
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })
    writeStub(
      join(farm.root, 'bin', 'forge'),
      'forge',
      join(farm.root, 'argv.log'),
      'forge Version: 0.0.1'
    )

    const output = runInFarm(farm, [
      `source script/helperFunctions.sh >/dev/null 2>&1`,
      `ensureStandardArtifactForSalt NoSuchContractForTheSaltPath`,
      `echo "SALT_RC=$?"`,
    ])

    expect(output).toContain('SALT_RC=1')
    expect(output).toContain('Cannot confirm the local foundry')
    expect(farm.argv().some((argv) => argv.startsWith('forge build'))).toBe(
      false
    )
  })

  it('runs the deploy-salt build once the forge matches', () => {
    const farm = makeFarm({ zkForgeVersion: ZK_FOUNDRY_PIN })

    const output = runInFarm(farm, [
      `source script/helperFunctions.sh >/dev/null 2>&1`,
      `ensureStandardArtifactForSalt NoSuchContractForTheSaltPath`,
      `echo "SALT_RC=$?"`,
    ])

    // Still 1 - the stub produces no artifact - but for the later reason, which is what
    // separates "the gate refused" from "the build failed".
    expect(output).toContain('SALT_RC=1')
    expect(output).not.toContain('Cannot confirm the local foundry')
    expect(farm.argv().some((argv) => argv.startsWith('forge build'))).toBe(
      true
    )
  })

  it('refuses scriptMaster startup compile before it starts a forge', () => {
    const farm = makeFarm({
      zkForgeVersion: ZK_FOUNDRY_PIN,
      env: ['COMPILE_ON_STARTUP=true'],
    })
    writeStub(
      join(farm.root, 'bin', 'forge'),
      'forge',
      join(farm.root, 'argv.log'),
      'forge Version: 0.0.1'
    )
    // gum drives the interactive prompts that follow the compile step, so a run that got
    // past the gate does not hang.
    writeStub(join(farm.root, 'bin', 'gum'), 'gum', join(farm.root, 'argv.log'))

    const output = runInFarm(farm, [
      `source script/helperFunctions.sh >/dev/null 2>&1`,
      `source script/scriptMaster.sh >/dev/null 2>&1`,
      `scriptMaster`,
      `echo "MASTER_RC=$?"`,
    ])

    expect(output).toContain('MASTER_RC=1')
    expect(output).toContain('Cannot confirm the local foundry')
    expect(farm.argv().some((argv) => argv.startsWith('forge build'))).toBe(
      false
    )
  })
})

describe('deployAndStoreCREATE3Factory needs no gate of its own', () => {
  it('cannot reach its fallback build after the seam refuses', () => {
    // Its `forge build` is only reached when the preceding executeAndParse left a
    // chain-unsupported message in STDERR_CONTENT. The seam's refusal replaces that
    // message, so a refused run cannot enter the branch - which is why a second gate here
    // would only duplicate the first.
    const source = readFileSync(
      join(REPO_ROOT, 'script/deploy/deployAndStoreCREATE3Factory.sh'),
      'utf8'
    )
    const seamRefusal = readFileSync(
      join(REPO_ROOT, 'script/helperFunctions.sh'),
      'utf8'
    ).match(/STDERR_CONTENT="(refused:[^"]*)"/)

    expect(seamRefusal).not.toBeNull()
    expect(source).toContain('executeAndParse')
    expect(source).toContain(
      // eslint-disable-next-line no-template-curly-in-string
      '"${STDERR_CONTENT:-}" == *"Chain"*'
    )
    expect(seamRefusal?.[1]).not.toContain('Chain')
  })
})

describe('the checkout itself', () => {
  it('carries both zk pins, so the gate has something to compare against', () => {
    expect(ZKSOLC_PIN).toMatch(/^\d+\.\d+\.\d+$/)
    expect(ZK_FOUNDRY_PIN).toMatch(/^v?\d+\.\d+\.\d+$|^nightly-/)
  })

  it('keeps the zk pin reader loadable on its own', () => {
    // The checker sources it without helperFunctions.sh, which reads .env and would need a
    // configured tree.
    const result = spawnSync(
      'bash',
      ['-c', `source ${PIN_READER}\ngetZkToolchainPin zksolc`],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(ZKSOLC_PIN)
  })
})

describe('deploy-smoke-test triggers on the deploy chokepoint', () => {
  it('lists a filter that matches the file the seam lives in', () => {
    const workflow = readFileSync(
      join(REPO_ROOT, '.github/workflows/deploy-smoke-test.yml'),
      'utf8'
    )
    const filters = (workflow.match(/^\s+- '([^']+)'$/gm) ?? []).map((line) =>
      line.trim().replace(/^- '/, '').replace(/'$/, '')
    )

    /**
     * Whether any filter glob matches a path, with `**` spanning separators and `*` not.
     *
     * @param path - Repository-relative path.
     * @returns True when the smoke job would run for a change to it.
     */
    const covered = (path: string): boolean =>
      filters.some((glob) =>
        new RegExp(
          `^${glob
            .split('**')
            .map((part) =>
              part
                .split('*')
                .map((atom) => atom.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
                .join('[^/]*')
            )
            .join('.*')}$`
        ).test(path)
      )

    expect(covered('script/helperFunctions.sh')).toBe(true)
    expect(covered('script/scriptMaster.sh')).toBe(true)
    expect(covered('script/deploy/shared/assertZkToolchain.sh')).toBe(true)
    expect(covered(CHECKER)).toBe(true)
    expect(covered(PIN_READER)).toBe(true)
    // A matcher that answered true for everything would make the assertions above empty.
    expect(covered('README.md')).toBe(false)
    expect(covered('docs/Setup.md')).toBe(false)
  })
})
