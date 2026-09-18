/**
 * Pins how the grouped deploy runners select the london build: by exporting
 * `FOUNDRY_PROFILE` for the london group and clearing it for the cancun group,
 * never by rewriting `foundry.toml` — a rewritten `foundry.toml` is what the
 * tree-reproducibility guard refuses a production deploy over. Each case drives
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

/** A london-EVM mainnet, so the getters take their non-zk branch. */
const LONDON_NETWORK = 'fuse'
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
