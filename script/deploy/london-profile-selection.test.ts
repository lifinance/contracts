/**
 * Pins how the deploy paths select the london build: the grouped runners export
 * `FOUNDRY_PROFILE` for the london group and clear it for the cancun group, and
 * a direct deploy selects it from the network — never by rewriting
 * `foundry.toml`, which is what the tree-reproducibility guard refuses a
 * production deploy over. Each case drives
 * the real bash helpers inside a throwaway git checkout whose `forge` is a stub
 * that records the profile it was handed, so nothing can be built or broadcast.
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
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

import {
  deriveToolchainScope,
  parseBuildProfiles,
} from './codehash/lineage-scope'
import { withholdCredentials } from './safe/spawn-env'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const NETWORKS = JSON.parse(
  readFileSync(join(REPO_ROOT, 'config', 'networks.json'), 'utf8')
) as Record<string, { targetEvmVersion: string; isZkEVM: boolean }>
const FOUNDRY_TOML = readFileSync(join(REPO_ROOT, 'foundry.toml'), 'utf8')
const PROFILES = parseBuildProfiles(FOUNDRY_TOML)
const FORGE_VERSION = readFileSync(
  join(REPO_ROOT, '.foundry-version'),
  'utf8'
).trim()

/**
 * The literal the runners export and the sign-time rebuild resolves by name.
 * Spelled out rather than read from a constant, because the value is what the
 * rebuild needs to find in a checkout at an older commit — a rename that both
 * sides follow would leave every test green and every london slot MISMATCH.
 */
const LONDON_PROFILE = 'solc_floor'

/** The local anvil chain the deploy smoke test drives; its row names no EVM version. */
const LOCAL_NETWORK = 'localanvil'

/** A london-EVM mainnet, so the getters take their non-zk branch. */
const LONDON_NETWORK = 'fuse'
/** A cancun mainnet, which builds under the default profile. */
const CANCUN_NETWORK = 'base'
const UNSET = '<unset>'

/** A `.env` the helpers accept, holding only path settings and no credentials. */
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

interface ISandbox {
  root: string
  /** Every `forge` argv plus the profile it saw, in call order. */
  forgeCalls: () => string[]
  /** `git status --porcelain` restricted to foundry.toml; '' means untouched. */
  foundryTomlStatus: () => string
}

const git = (cwd: string, args: string[]): void => {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' }
  )
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/**
 * Builds a committed checkout the helpers can run in. `script/`, `config/` and
 * `lib/` are the repo's own by symlink; `foundry.toml` is a committed copy so
 * `git status` can tell whether a helper rewrote it.
 */
const makeSandbox = (): ISandbox => {
  const root = mkdtempSync(join(tmpdir(), 'london-profile-'))
  const log = join(root, 'forge.log')
  writeFileSync(log, '')

  for (const entry of ['script', 'config', 'lib', 'out'])
    if (existsSync(join(REPO_ROOT, entry)))
      symlinkSync(join(REPO_ROOT, entry), join(root, entry))
  for (const entry of ['foundry.toml', '.foundry-version', 'remappings.txt'])
    copyFileSync(join(REPO_ROOT, entry), join(root, entry))
  writeFileSync(join(root, '.env'), HARMLESS_ENV)

  git(root, ['init', '-q'])
  git(root, ['add', 'foundry.toml', '.foundry-version', 'remappings.txt'])
  git(root, ['commit', '-q', '-m', 'baseline'])

  mkdirSync(join(root, 'bin'))
  writeFileSync(
    join(root, 'bin', 'forge'),
    [
      '#!/bin/bash',
      `printf 'forge %s FOUNDRY_PROFILE=%s\\n' "$*" "\${FOUNDRY_PROFILE-${UNSET}}" >> "${log}"`,
      `if [ "$1" = "--version" ]; then echo "forge Version: ${FORGE_VERSION}"; fi`,
      'exit 0',
      '',
    ].join('\n')
  )
  chmodSync(join(root, 'bin', 'forge'), 0o755)
  // Every other binary that could reach a chain or the network is inert.
  for (const binary of ['cast', 'bun', 'bunx', 'curl', 'wget']) {
    writeFileSync(join(root, 'bin', binary), '#!/bin/bash\nexit 1\n')
    chmodSync(join(root, 'bin', binary), 0o755)
  }

  return {
    root,
    forgeCalls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
    foundryTomlStatus: () =>
      spawnSync('git', ['status', '--porcelain', '--', 'foundry.toml'], {
        cwd: root,
        encoding: 'utf8',
      }).stdout.trim(),
  }
}

/**
 * Runs a bash snippet in the sandbox with its stubs first on PATH. The parent's
 * own `FOUNDRY_PROFILE` never reaches the child, so a case starts from a clean
 * slate unless it sets one.
 */
const run = (
  sandbox: ISandbox,
  lines: string[],
  environment: Record<string, string> = {}
): string => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'FOUNDRY_PROFILE') env[name] = value
  Object.assign(env, environment)
  env['PATH'] = `${join(sandbox.root, 'bin')}:${process.env['PATH'] ?? ''}`
  withholdCredentials(env)

  const result = spawnSync('bash', ['-c', lines.join('\n')], {
    cwd: sandbox.root,
    encoding: 'utf8',
    env,
  })
  return `${result.stdout}${result.stderr}`
}

const SOURCE_HELPERS = [
  'source script/helperFunctions.sh >/dev/null 2>&1',
  'source script/deploy/resources/deployGroupingHelpers.sh',
]

const REPORT_GETTERS = [
  `echo "SOLC=$(getSolcVersion ${LONDON_NETWORK})"`,
  `echo "EVM=$(getEvmVersion ${LONDON_NETWORK})"`,
]

const london = PROFILES[LONDON_PROFILE]
const fallback = PROFILES['default']
if (london === undefined || fallback === undefined)
  throw new Error(
    `foundry.toml must pin both [profile.${LONDON_PROFILE}] and a default profile`
  )

describe(`[profile.${LONDON_PROFILE}] in foundry.toml`, () => {
  it('pins the pair the london group needs and nothing else', () => {
    // The evm name is what puts a network in the london group; the solc pin
    // has to differ from the default's or the getters below could pass by
    // falling back.
    expect(london.evmVersion).toBe('london')
    expect(london.solcVersion).not.toBe(fallback.solcVersion)

    // Any further key — `skip` above all — would stop the deploy scripts under
    // this profile from compiling, or drift its codegen from the default's.
    const body = FOUNDRY_TOML.split(/\n(?=\[)/).find((section) =>
      section.startsWith(`[profile.${LONDON_PROFILE}]`)
    )
    expect(body).toBeDefined()
    const keys = (body ?? '')
      .split('\n')
      .slice(1)
      .filter((line) => /^\s*[A-Za-z_]/.test(line))
      .map((line) => line.split('=')[0]?.trim())
    expect(keys.sort()).toEqual(['evm_version', 'solc_version'])
  })
})

describe('getSolcVersion / getEvmVersion read the active profile', () => {
  it(`reports the london pair when FOUNDRY_PROFILE=${LONDON_PROFILE}`, () => {
    const output = run(makeSandbox(), [...SOURCE_HELPERS, ...REPORT_GETTERS], {
      FOUNDRY_PROFILE: LONDON_PROFILE,
    })

    expect(output).toContain(`SOLC=${london.solcVersion}`)
    expect(output).toContain(`EVM=${london.evmVersion}`)
  })

  it('report the default pair when no profile is set', () => {
    const output = run(makeSandbox(), [...SOURCE_HELPERS, ...REPORT_GETTERS])

    expect(output).toContain(`SOLC=${fallback.solcVersion}`)
    expect(output).toContain(`EVM=${fallback.evmVersion}`)
    expect(fallback.evmVersion).toBe('cancun')
  })

  it('fall back to the default pair for a profile that pins neither, as forge does', () => {
    const output = run(makeSandbox(), [...SOURCE_HELPERS, ...REPORT_GETTERS], {
      FOUNDRY_PROFILE: 'ci',
    })

    expect(output).toContain(`SOLC=${fallback.solcVersion}`)
    expect(output).toContain(`EVM=${fallback.evmVersion}`)
  })
})

describe('prepareGroupBuild', () => {
  const REPORT_STATE = [
    'echo "RC=$?"',
    `echo "PROFILE_AFTER=\${FOUNDRY_PROFILE-${UNSET}}"`,
  ]

  it(`builds the london group under FOUNDRY_PROFILE=${LONDON_PROFILE} and leaves foundry.toml committed`, () => {
    const sandbox = makeSandbox()

    const output = run(sandbox, [
      ...SOURCE_HELPERS,
      'prepareGroupBuild "$GROUP_LONDON" true',
      ...REPORT_STATE,
    ])

    expect(output).toContain('RC=0')
    expect(sandbox.foundryTomlStatus()).toBe('')
    expect(
      sandbox.forgeCalls().filter((call) => call.startsWith('forge build'))
    ).toEqual([
      expect.stringMatching(new RegExp(` FOUNDRY_PROFILE=${LONDON_PROFILE}$`)),
    ])
    // Workers launched after this inherit the exporting shell's environment,
    // so the profile has to still be set once the helper returns.
    expect(output).toContain(`PROFILE_AFTER=${LONDON_PROFILE}`)
  })

  it('builds the cancun group with the profile cleared, even right after a london group', () => {
    const sandbox = makeSandbox()

    const output = run(sandbox, [
      ...SOURCE_HELPERS,
      'prepareGroupBuild "$GROUP_LONDON" true',
      'prepareGroupBuild "$GROUP_CANCUN" true',
      ...REPORT_STATE,
    ])

    expect(output).toContain('RC=0')
    expect(sandbox.foundryTomlStatus()).toBe('')
    expect(
      sandbox
        .forgeCalls()
        .filter((call) => call.startsWith('forge build'))
        .map((call) => call.split(' FOUNDRY_PROFILE=')[1])
    ).toEqual([LONDON_PROFILE, UNSET])
    expect(output).toContain(`PROFILE_AFTER=${UNSET}`)
  })

  it('clears a profile the operator shell exported before the cancun group', () => {
    const sandbox = makeSandbox()

    run(
      sandbox,
      [...SOURCE_HELPERS, 'prepareGroupBuild "$GROUP_CANCUN" true'],
      { FOUNDRY_PROFILE: LONDON_PROFILE }
    )

    expect(
      sandbox.forgeCalls().filter((call) => call.startsWith('forge build'))
    ).toEqual([expect.stringMatching(new RegExp(` FOUNDRY_PROFILE=${UNSET}$`))])
  })

  it('clears a profile the operator shell exported before the zkevm group', () => {
    const sandbox = makeSandbox()

    const output = run(
      sandbox,
      [
        ...SOURCE_HELPERS,
        'prepareGroupBuild "$GROUP_ZKEVM" true',
        ...REPORT_STATE,
      ],
      { FOUNDRY_PROFILE: LONDON_PROFILE }
    )

    expect(output).toContain('RC=0')
    // The zk builds carry their own inline FOUNDRY_PROFILE=zksync, but
    // ensureStandardArtifactForSalt's plain `forge build` does not: a london
    // pin surviving into it derives the CREATE2 salt from bytecode no other
    // chain in the wave was built with.
    expect(output).toContain(`PROFILE_AFTER=${UNSET}`)
  })

  it('refuses the london group when foundry.toml has no such profile', () => {
    const sandbox = makeSandbox()
    const toml = join(sandbox.root, 'foundry.toml')
    writeFileSync(
      toml,
      readFileSync(toml, 'utf8').replace(
        `[profile.${LONDON_PROFILE}]`,
        '[profile.renamed_away]'
      )
    )

    const output = run(sandbox, [
      ...SOURCE_HELPERS,
      'prepareGroupBuild "$GROUP_LONDON" true',
      ...REPORT_STATE,
    ])

    expect(output).toContain('RC=1')
    expect(output).toContain(`[profile.${LONDON_PROFILE}]`)
    // The paired present: the refusal lands before the build, so forge never
    // got the chance to fall back to [profile.default] and exit 0.
    expect(
      sandbox.forgeCalls().filter((call) => call.startsWith('forge build'))
    ).toEqual([])
  })

  // `declare -F a b c` returns 1 when ANY name is missing, so one call cannot
  // tell a fully removed set from a partially reintroduced one.
  for (const removed of [
    'backupFoundryToml',
    'restoreFoundryToml',
    'updateFoundryTomlForGroup',
  ])
    it(`does not define ${removed}`, () => {
      const output = run(makeSandbox(), [
        ...SOURCE_HELPERS,
        `declare -F ${removed}`,
        'echo "DECLARED_RC=$?"',
      ])

      expect(output).toContain('DECLARED_RC=1')
    })
})

/**
 * The direct entry points (scriptMaster and the deploy*.sh wrappers) run no
 * group build, so the profile forge compiles under is whatever the shell holds.
 * Each case drives the real deploySingleContract as far as its first
 * `forge build`, which the stub records and then fails by leaving no artifact.
 */
describe('deploySingleContract selects the profile from the network', () => {
  const DEPLOY = (network: string): string[] => [
    ...SOURCE_HELPERS,
    'source script/deploy/deploySingleContract.sh',
    `deploySingleContract Executor ${network} staging 1.0.0 false`,
    'echo "RC=$?"',
    `echo "PROFILE_AFTER=\${FOUNDRY_PROFILE-${UNSET}}"`,
    `echo "SOLC=$(getSolcVersion ${network})"`,
    `echo "EVM=$(getEvmVersion ${network})"`,
  ]
  const buildProfiles = (sandbox: ISandbox): string[] =>
    sandbox
      .forgeCalls()
      .filter((call) => call.startsWith('forge build'))
      .map((call) => call.split(' FOUNDRY_PROFILE=')[1] ?? '')
  /** No `out/`: the salt derivation then has to run `forge build` itself. */
  const makeDeploySandbox = (): ISandbox => {
    const sandbox = makeSandbox()
    const out = join(sandbox.root, 'out')
    if (existsSync(out)) unlinkSync(out)
    return sandbox
  }

  it('is a pair of one london and one cancun network', () => {
    expect(NETWORKS[LONDON_NETWORK]?.targetEvmVersion).toBe('london')
    expect(NETWORKS[CANCUN_NETWORK]?.targetEvmVersion).toBe('cancun')
  })

  it(`builds a london network under FOUNDRY_PROFILE=${LONDON_PROFILE} when the shell holds none`, () => {
    const sandbox = makeDeploySandbox()

    const output = run(sandbox, DEPLOY(LONDON_NETWORK))

    expect(output).not.toContain('refusing to deploy')
    expect(buildProfiles(sandbox)).toEqual([LONDON_PROFILE])
    expect(output).toContain(`PROFILE_AFTER=${LONDON_PROFILE}`)
    // The record the deploy would write reads the same profile.
    expect(output).toContain(`SOLC=${london.solcVersion}`)
    expect(output).toContain(`EVM=${london.evmVersion}`)
  })

  it('builds a cancun network under the default profile when the shell holds none', () => {
    const sandbox = makeDeploySandbox()

    const output = run(sandbox, DEPLOY(CANCUN_NETWORK))

    expect(output).not.toContain('refusing to deploy')
    expect(buildProfiles(sandbox)).toEqual([UNSET])
    expect(output).toContain(`PROFILE_AFTER=${UNSET}`)
    expect(output).toContain(`SOLC=${fallback.solcVersion}`)
    expect(output).toContain(`EVM=${fallback.evmVersion}`)
  })

  it('keeps a profile the shell exported when it fits the network', () => {
    // The grouped runners export the profile before launching their workers.
    const sandbox = makeDeploySandbox()

    const output = run(sandbox, DEPLOY(LONDON_NETWORK), {
      FOUNDRY_PROFILE: LONDON_PROFILE,
    })

    expect(output).not.toContain('refusing to deploy')
    expect(buildProfiles(sandbox)).toEqual([LONDON_PROFILE])
  })

  it.each([
    [LONDON_PROFILE, CANCUN_NETWORK],
    // `ci` pins no pair, so it resolves to the default's cancun.
    ['ci', LONDON_NETWORK],
  ])(
    'refuses FOUNDRY_PROFILE=%s for %s before any forge build',
    (profile, network) => {
      const sandbox = makeDeploySandbox()

      const output = run(sandbox, DEPLOY(network), {
        FOUNDRY_PROFILE: profile,
      })

      expect(output).toContain('RC=1\n')
      expect(output).toContain('refusing to deploy')
      expect(output).toContain(`FOUNDRY_PROFILE=${profile}`)
      expect(buildProfiles(sandbox)).toEqual([])
    }
  )

  it('re-selects for the next network when it chose the previous profile itself', () => {
    // scriptMaster deploys one contract to every network in a single loop, so
    // the london export must not be read as the operator's choice at the next
    // cancun network.
    const output = run(makeSandbox(), [
      ...SOURCE_HELPERS,
      `selectFoundryProfileForNetwork ${LONDON_NETWORK}`,
      `echo "PROFILE_BETWEEN=\${FOUNDRY_PROFILE-${UNSET}}"`,
      `selectFoundryProfileForNetwork ${CANCUN_NETWORK}`,
      'echo "RC=$?"',
      `echo "PROFILE_AFTER=\${FOUNDRY_PROFILE-${UNSET}}"`,
    ])

    expect(output).toContain(`PROFILE_BETWEEN=${LONDON_PROFILE}`)
    expect(output).toContain('RC=0')
    expect(output).toContain(`PROFILE_AFTER=${UNSET}`)
  })

  it('verifies, and does not re-select, a profile a group build exported', () => {
    const output = run(makeSandbox(), [
      ...SOURCE_HELPERS,
      'prepareGroupBuild "$GROUP_LONDON" true',
      `selectFoundryProfileForNetwork ${CANCUN_NETWORK}`,
      'echo "RC=$?"',
      `echo "PROFILE_AFTER=\${FOUNDRY_PROFILE-${UNSET}}"`,
    ])

    expect(output).toContain('RC=1\n')
    expect(output).toContain(`PROFILE_AFTER=${LONDON_PROFILE}`)
  })

  it('accepts a network whose row names no EVM version, and still refuses an unknown one', () => {
    // `localanvil` is the only row in config/networks.json with an empty
    // targetEvmVersion, and it is what the deploy smoke test deploys to: a row
    // that names no version states nothing the active profile can contradict.
    expect(NETWORKS[LOCAL_NETWORK]?.targetEvmVersion).toBe('')

    const output = run(makeSandbox(), [
      ...SOURCE_HELPERS,
      `selectFoundryProfileForNetwork ${LOCAL_NETWORK}`,
      'echo "LOCAL_RC=$?"',
      `echo "PROFILE_AFTER=\${FOUNDRY_PROFILE-${UNSET}}"`,
      'selectFoundryProfileForNetwork nosuchnetwork',
      'echo "UNKNOWN_RC=$?"',
    ])

    expect(output).toContain('LOCAL_RC=0')
    expect(output).toContain(`PROFILE_AFTER=${UNSET}`)
    // The paired present: skipping the comparison for an unnamed version is not
    // the same as skipping it for a row that is not there at all.
    expect(output).toContain('UNKNOWN_RC=1')
  })

  it('selects before the compiler-pair guard, which reads the active profile', () => {
    const text = readFileSync(
      join(REPO_ROOT, 'script', 'deploy', 'deploySingleContract.sh'),
      'utf8'
    )
    const select = text.indexOf('selectFoundryProfileForNetwork "$NETWORK"')
    const guard = text.indexOf('getSolcVersion "$NETWORK" >/dev/null')
    expect(select).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(select)
  })
})

describe('the deploy side and the sign-time rebuild agree on the profile name', () => {
  it('resolves the london network to the profile the runners export', () => {
    // The rebuild takes this name from today's foundry.toml and hands it to a
    // forge run inside a checkout at the deployment commit. Renaming the
    // section moves this resolution with it and leaves the older checkouts
    // behind, where forge answers the unknown name with [profile.default].
    const row = NETWORKS[LONDON_NETWORK]
    if (row === undefined)
      throw new Error(`config/networks.json has no "${LONDON_NETWORK}" row`)

    const scope = deriveToolchainScope(LONDON_NETWORK, {
      networks: { [LONDON_NETWORK]: row },
      profiles: PROFILES,
    })

    expect(scope.profiles.map((profile) => profile.profile)).toEqual([
      LONDON_PROFILE,
    ])
  })
})

describe('getFoundryProfileValue', () => {
  const REPORT = (call: string) => [
    `${call} >value.txt 2>error.txt`,
    'echo "RC=$?"',
    'echo "VALUE=$(cat value.txt)"',
    'echo "ERROR=$(cat error.txt)"',
  ]

  it('reads a key written without spaces around the equals sign', () => {
    const sandbox = makeSandbox()
    const toml = join(sandbox.root, 'foundry.toml')
    const spaced = `solc_version = '${london.solcVersion}'`
    const before = readFileSync(toml, 'utf8')
    expect(before).toContain(spaced)
    writeFileSync(
      toml,
      before.replace(spaced, `solc_version='${london.solcVersion}'`)
    )

    const output = run(
      sandbox,
      [...SOURCE_HELPERS, ...REPORT('getFoundryProfileValue solc_version')],
      { FOUNDRY_PROFILE: LONDON_PROFILE }
    )

    // A miss here would fall through to [profile.default] and report its pin.
    expect(output).toContain('RC=0')
    expect(output).toContain(`VALUE=${london.solcVersion}`)
    expect(london.solcVersion).not.toBe(fallback.solcVersion)
  })

  it('refuses, and prints nothing, when neither profile declares the key', () => {
    const output = run(makeSandbox(), [
      ...SOURCE_HELPERS,
      ...REPORT('getFoundryProfileValue no_such_key'),
    ])

    expect(output).toContain('RC=1')
    expect(output).toContain('VALUE=\n')
    expect(output).toContain('declares no_such_key')
  })

  it('refuses when the toml file FOUNDRY_TOML_FILE_PATH names does not exist', () => {
    const output = run(makeSandbox(), [
      ...SOURCE_HELPERS,
      ...REPORT(
        'FOUNDRY_TOML_FILE_PATH=/nonexistent/foundry.toml getFoundryProfileValue solc_version'
      ),
    ])

    expect(output).toContain('RC=1')
    expect(output).toContain('VALUE=\n')
    expect(output).toContain('not found at /nonexistent/foundry.toml')
  })
})

/**
 * The zkevm branch of prepareGroupBuild clears the profile, but only when a
 * runner calls it: the two production runners build zk inline, so the call has
 * to sit in each zkevm wave itself, before the wave is launched.
 */
describe('every runner clears the group profile before its zkevm wave', () => {
  const source = (path: string): string =>
    readFileSync(join(REPO_ROOT, path), 'utf8')

  it.each([
    ['script/deploy/deployContractToNetworks.sh', 'launchDeployWave 1 '],
    ['script/tasks/proposeContractToNetworks.sh', 'launchProposeWave 1 '],
  ])(
    '%s calls prepareGroupBuild zkevm inside the zkevm wave',
    (path, launch) => {
      const text = source(path)
      const start = text.indexOf('=== zkevm group')
      const end = text.indexOf(launch, start)
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)

      expect(text.slice(start, end)).toContain(
        'prepareGroupBuild "$GROUP_ZKEVM" true'
      )
    }
  )

  it('multiNetworkExecution.sh clears the profile on both of its exits, because it is sourced', () => {
    const text = source('script/multiNetworkExecution.sh')
    const handler = text.slice(
      text.indexOf('_global_interrupt_handler() {'),
      text.indexOf('exit 130')
    )
    const groupRun = text.slice(
      text.indexOf('function executeNetworksByGroup()'),
      text.indexOf('Generating final execution summary')
    )
    expect(handler.length).toBeGreaterThan(0)
    expect(groupRun.length).toBeGreaterThan(0)

    expect(handler).toContain('unset FOUNDRY_PROFILE')
    // After the london group, which runs last and exports the profile.
    const londonDone = groupRun.indexOf('London EVM group completed')
    expect(londonDone).toBeGreaterThan(-1)
    expect(groupRun.slice(londonDone)).toContain('unset FOUNDRY_PROFILE')
  })
})
