/**
 * Tests for `script/deploy/verifyRolloutContracts.sh`.
 *
 * The script is sourced into a harness shell next to the real helperFunctions.sh helpers it
 * uses for address lookup and the exclusion gate. A fake `bunx` on PATH stands in for both
 * deployment-log CLIs and records every invocation, and `verifyContract` is redefined after
 * sourcing, so no case reaches Mongo, an RPC or an explorer.
 */
import { spawnSync } from 'child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SCRIPT = join(REPO_ROOT, 'script/deploy/verifyRolloutContracts.sh')

const CONTRACT = 'AcrossFacetV3'
const VERSION = '1.2.0'
const ADDRESS_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111'
const ADDRESS_B = '0x2222222222222222222222222222222222222222'
const ADDRESS_C = '0x3333333333333333333333333333333333333333'
const STALE_ADDRESS = '0x9999999999999999999999999999999999999999'

const HELPERS = [
  'getFileSuffix',
  'checkIfFileExists',
  'getContractAddressFromDeploymentLogs',
  'isNetworkExcludedFromVerification',
  'error',
  'warning',
  'success',
  'echoDebug',
]
  .map(
    (fn) =>
      `sed -nE '/^function ${fn}\\(\\) \\{/,/^\\}/p' "${REPO_ROOT}/script/helperFunctions.sh"`
  )
  .join('\n')

const FAKE_BUNX = `#!/bin/bash
echo "$*" >>"$STUB_DIR/bunx.log"
case "$*" in
*query-deployment-logs.ts*)
  [[ -f "$STUB_DIR/query.out" ]] && cat "$STUB_DIR/query.out"
  echo "query stderr marker" >&2
  exit "$(cat "$STUB_DIR/query.exit")"
  ;;
*update-deployment-logs.ts*)
  for NET in $(cat "$STUB_DIR/update.fail"); do
    [[ "$*" == *"--network $NET "* ]] && { echo "update failed for $NET" >&2; exit 1; }
  done
  exit 0
  ;;
esac
exit 99
`

interface IRecord {
  contractName: string
  network: string
  version: string
  address: string
  verified: boolean
  constructorArgs: string
}

function record(
  network: string,
  address: string,
  overrides: Partial<IRecord> = {}
): IRecord {
  return {
    contractName: CONTRACT,
    network,
    version: VERSION,
    address,
    verified: false,
    constructorArgs: `0xargs${network}`,
    ...overrides,
  }
}

interface IRunOptions {
  networks: string[]
  records?: IRecord[]
  rawQueryOutput?: string
  queryExit?: number
  deployments?: Record<string, Record<string, string>>
  failVerify?: string[]
  failUpdate?: string[]
  excluded?: string
  environment?: string
  args?: string[]
}

interface IRunResult {
  status: number | null
  output: string
  queries: string[]
  updates: string[]
  verifies: string[]
}

let workDir = ''

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'verify-rollout-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function run(options: IRunOptions): IRunResult {
  const stubDir = join(workDir, 'stub')
  const binDir = join(workDir, 'bin')
  mkdirSync(stubDir)
  mkdirSync(binDir)
  mkdirSync(join(workDir, 'deployments'))

  writeFileSync(join(binDir, 'bunx'), FAKE_BUNX, { mode: 0o755 })
  writeFileSync(
    join(stubDir, 'query.out'),
    options.rawQueryOutput ?? JSON.stringify(options.records ?? [], null, 2)
  )
  writeFileSync(join(stubDir, 'query.exit'), String(options.queryExit ?? 0))
  writeFileSync(
    join(stubDir, 'update.fail'),
    (options.failUpdate ?? []).join(' ')
  )

  const suffix = options.environment === 'staging' ? 'staging.' : ''
  for (const [network, map] of Object.entries(options.deployments ?? {}))
    writeFileSync(
      join(workDir, 'deployments', `${network}.${suffix}json`),
      JSON.stringify(map)
    )

  const harness = `
    source <(
${HELPERS}
    )
    source "${SCRIPT}"
    verifyContract() {
      echo "$*" >>"$STUB_DIR/verify.log"
      [[ ",$FAIL_VERIFY," != *",$1,"* ]]
    }
    verifyRolloutContracts "$@"
  `
  const args = options.args ?? [
    options.environment ?? 'production',
    CONTRACT,
    VERSION,
    ...options.networks,
  ]
  const result = spawnSync('bash', ['-c', harness, 'harness', ...args], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: workDir,
      STUB_DIR: stubDir,
      FAIL_VERIFY: (options.failVerify ?? []).join(','),
      DO_NOT_VERIFY_IN_THESE_NETWORKS: options.excluded ?? '',
    },
  })

  const lines = (file: string): string[] => {
    const path = join(stubDir, file)
    return existsSync(path)
      ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
      : []
  }
  const calls = lines('bunx.log')
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    queries: calls.filter((c) => c.includes('query-deployment-logs.ts')),
    updates: calls.filter((c) => c.includes('update-deployment-logs.ts')),
    verifies: lines('verify.log'),
  }
}

function updateCall(network: string, address: string, env = 'production') {
  return (
    `tsx script/deploy/update-deployment-logs.ts update --env ${env} ` +
    `--network ${network} --contract ${CONTRACT} --version ${VERSION} ` +
    `--address ${address} --verified true`
  )
}

describe('verifyRolloutContracts selection', () => {
  it('makes exactly one filter query with an explicit limit and no cache', () => {
    const { status, queries } = run({ networks: ['base', 'arbitrum'] })

    expect(status).toBe(0)
    expect(queries).toEqual([
      `tsx script/deploy/query-deployment-logs.ts filter --env production ` +
        `--contract ${CONTRACT} --version ${VERSION} --verified false ` +
        `--limit 1000 --no-use-cache --format json`,
    ])
  })

  it('exits 0 and says nothing needed re-verifying on an empty selection', () => {
    const { status, output, verifies, updates } = run({
      networks: ['base'],
      records: [],
      deployments: { base: { [CONTRACT]: ADDRESS_A } },
    })

    expect(status).toBe(0)
    expect(output).toContain('nothing needed re-verifying')
    expect(verifies).toEqual([])
    expect(updates).toEqual([])
  })

  it('verifies and flips only records on the given networks whose address matches', () => {
    const { status, verifies, updates, output } = run({
      networks: ['base', 'arbitrum', 'optimism'],
      records: [
        record('base', ADDRESS_A.toUpperCase().replace('0X', '0x')),
        record('arbitrum', STALE_ADDRESS),
        record('polygon', ADDRESS_C),
      ],
      deployments: {
        base: { [CONTRACT]: ADDRESS_A },
        arbitrum: { [CONTRACT]: ADDRESS_B },
        optimism: { [CONTRACT]: ADDRESS_C },
        polygon: { [CONTRACT]: ADDRESS_C },
      },
    })

    expect(status).toBe(0)
    expect(verifies).toEqual([`base ${CONTRACT} ${ADDRESS_A} 0xargsbase`])
    expect(updates).toEqual([
      updateCall('base', ADDRESS_A.toUpperCase().replace('0X', '0x')),
    ])
    expect(output).toContain(STALE_ADDRESS)
  })

  it('skips a record whose network has no address in its deployment file', () => {
    const { status, verifies, updates } = run({
      networks: ['base'],
      records: [record('base', ADDRESS_A)],
      deployments: { base: { OtherFacet: ADDRESS_A } },
    })

    expect(status).toBe(0)
    expect(verifies).toEqual([])
    expect(updates).toEqual([])
  })

  it('reads the staging deployment file and passes the staging env through', () => {
    const { status, verifies, updates, queries } = run({
      environment: 'staging',
      networks: ['base'],
      records: [record('base', ADDRESS_A)],
      deployments: { base: { [CONTRACT]: ADDRESS_A } },
    })

    expect(status).toBe(0)
    expect(queries[0]).toContain('--env staging ')
    expect(verifies).toEqual([`base ${CONTRACT} ${ADDRESS_A} 0xargsbase`])
    expect(updates).toEqual([updateCall('base', ADDRESS_A, 'staging')])
  })

  it('never processes a superseded version the query returned', () => {
    const { verifies, updates } = run({
      networks: ['base'],
      records: [record('base', ADDRESS_A, { version: '1.1.0' })],
      deployments: { base: { [CONTRACT]: ADDRESS_A } },
    })

    expect(verifies).toEqual([])
    expect(updates).toEqual([])
  })
})

describe('verifyRolloutContracts exclusion gate', () => {
  it('reports an excluded network and never verifies or flips it', () => {
    const { status, verifies, updates, output } = run({
      networks: ['gnosis', 'base'],
      excluded: 'somechain,gnosis',
      records: [record('gnosis', ADDRESS_A), record('base', ADDRESS_B)],
      deployments: {
        gnosis: { [CONTRACT]: ADDRESS_A },
        base: { [CONTRACT]: ADDRESS_B },
      },
    })

    expect(status).toBe(0)
    expect(output).toMatch(/gnosis.*excluded/)
    expect(verifies).toEqual([`base ${CONTRACT} ${ADDRESS_B} 0xargsbase`])
    expect(updates).toEqual([updateCall('base', ADDRESS_B)])
  })
})

describe('verifyRolloutContracts failures', () => {
  it('fails on a non-zero query exit and surfaces its error', () => {
    const { status, output, verifies } = run({
      networks: ['base'],
      queryExit: 1,
      rawQueryOutput: '',
    })

    expect(status).not.toBe(0)
    expect(output).toContain('query stderr marker')
    expect(output).toMatch(/query.*failed/i)
    expect(verifies).toEqual([])
  })

  it('fails on invalid JSON instead of treating it as nothing to do', () => {
    const { status, output } = run({
      networks: ['base'],
      rawQueryOutput: 'not json at all',
    })

    expect(status).not.toBe(0)
    expect(output).toMatch(/invalid JSON/i)
    expect(output).not.toContain('nothing needed re-verifying')
  })

  it('fails on empty query output', () => {
    const { status, output } = run({ networks: ['base'], rawQueryOutput: '' })

    expect(status).not.toBe(0)
    expect(output).not.toContain('nothing needed re-verifying')
  })

  it('tolerates log lines printed before the JSON array', () => {
    const { status, updates } = run({
      networks: ['base'],
      rawQueryOutput: `[info] connecting\n${JSON.stringify([
        record('base', ADDRESS_A),
      ])}`,
      deployments: { base: { [CONTRACT]: ADDRESS_A } },
    })

    expect(status).toBe(0)
    expect(updates).toEqual([updateCall('base', ADDRESS_A)])
  })

  it('fails when the query fills the limit, since the selection may be truncated', () => {
    const records = Array.from({ length: 1000 }, () =>
      record('base', ADDRESS_A)
    )
    const { status, output, verifies } = run({
      networks: ['base'],
      records,
      deployments: { base: { [CONTRACT]: ADDRESS_A } },
    })

    expect(status).not.toBe(0)
    expect(output).toContain('1000')
    expect(verifies).toEqual([])
  })

  it('keeps going past a failed verify, names it, and does not flip its flag', () => {
    const { status, verifies, updates, output } = run({
      networks: ['base', 'arbitrum', 'optimism'],
      failVerify: ['base'],
      records: [
        record('base', ADDRESS_A),
        record('arbitrum', ADDRESS_B),
        record('optimism', ADDRESS_C),
      ],
      deployments: {
        base: { [CONTRACT]: ADDRESS_A },
        arbitrum: { [CONTRACT]: ADDRESS_B },
        optimism: { [CONTRACT]: ADDRESS_C },
      },
    })

    expect(status).not.toBe(0)
    expect(verifies).toHaveLength(3)
    expect(updates).toEqual([
      updateCall('arbitrum', ADDRESS_B),
      updateCall('optimism', ADDRESS_C),
    ])
    expect(output).toContain(`base ${ADDRESS_A}`)
  })

  it('keeps going past a failed flag update and names it', () => {
    const { status, updates, output } = run({
      networks: ['base', 'arbitrum'],
      failUpdate: ['base'],
      records: [record('base', ADDRESS_A), record('arbitrum', ADDRESS_B)],
      deployments: {
        base: { [CONTRACT]: ADDRESS_A },
        arbitrum: { [CONTRACT]: ADDRESS_B },
      },
    })

    expect(status).not.toBe(0)
    expect(updates).toEqual([
      updateCall('base', ADDRESS_A),
      updateCall('arbitrum', ADDRESS_B),
    ])
    expect(output).toContain(`base ${ADDRESS_A}`)
    expect(output).toContain('update failed for base')
  })
})

describe('verifyRolloutContracts arguments', () => {
  it('rejects a call without networks', () => {
    const { status, queries } = run({
      networks: [],
      args: ['production', CONTRACT, VERSION],
    })

    expect(status).not.toBe(0)
    expect(queries).toEqual([])
  })

  it('rejects an unknown environment', () => {
    const { status, queries } = run({
      networks: [],
      args: ['prod', CONTRACT, VERSION, 'base'],
    })

    expect(status).not.toBe(0)
    expect(queries).toEqual([])
  })
})
