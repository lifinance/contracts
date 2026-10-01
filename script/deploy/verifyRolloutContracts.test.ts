/**
 * Tests for `script/deploy/verifyRolloutContracts.sh`.
 *
 * The script is sourced into a harness shell next to the real helperFunctions.sh helpers it
 * uses for address lookup and the exclusion gate. A fake `bunx` on PATH stands in for both
 * deployment-log CLIs and records every invocation, and `verifyContract` is redefined after
 * sourcing, so no case reaches Mongo, an RPC or an explorer. Networks run concurrently, so
 * recorded calls are compared sorted.
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
const ADDRESS_A_UPPER = ADDRESS_A.toUpperCase().replace('0X', '0x')
const ADDRESS_B = '0x2222222222222222222222222222222222222222'
const ADDRESS_C = '0x3333333333333333333333333333333333333333'
const STALE_ADDRESS = '0x9999999999999999999999999999999999999999'
const KNOWN_NETWORKS = [
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'gnosis',
  'tron',
]

const HELPERS = [
  'getFileSuffix',
  'checkIfFileExists',
  'getContractAddressFromDeploymentLogs',
  'isNetworkExcludedFromVerification',
  'isTronNetwork',
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
  solcVersion: string
  evmVersion: string
  optimizerRuns: string
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
    solcVersion: '0.8.29',
    evmVersion: 'cancun',
    optimizerRuns: '1000000',
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
  maxConcurrentJobs?: string
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
  const networksJson = join(workDir, 'networks.json')
  writeFileSync(
    networksJson,
    JSON.stringify(Object.fromEntries(KNOWN_NETWORKS.map((n) => [n, {}])))
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
    # clobbers like the real verify helpers, which assign these without \`local\`
    verifyContract() {
      echo "$*" >>"$STUB_DIR/verify.log"
      CONTRACT=Clobbered VERSION=0.0.0 ENVIRONMENT=clobbered
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
  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: workDir,
    STUB_DIR: stubDir,
    NETWORKS_JSON_FILE_PATH: networksJson,
    FAIL_VERIFY: (options.failVerify ?? []).join(','),
    DO_NOT_VERIFY_IN_THESE_NETWORKS: options.excluded ?? '',
  }
  if (options.maxConcurrentJobs !== undefined)
    env.MAX_CONCURRENT_JOBS = options.maxConcurrentJobs
  const result = spawnSync('bash', ['-c', harness, 'harness', ...args], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 30_000,
    env,
  })

  const lines = (file: string): string[] => {
    const path = join(stubDir, file)
    return existsSync(path)
      ? readFileSync(path, 'utf8').split('\n').filter(Boolean).sort()
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

function markCall(network: string, address: string, env = 'production') {
  return (
    `tsx script/deploy/update-deployment-logs.ts mark-verified --env ${env} ` +
    `--network ${network} --contract ${CONTRACT} --address ${address}`
  )
}

function verifyCall(
  network: string,
  address: string,
  settings = '0.8.29 cancun 1000000'
) {
  return `${network} ${CONTRACT} ${address} 0xargs${network} ${settings}`
}

describe('verifyRolloutContracts selection', () => {
  it('makes exactly one query for every record of the version, with no cache', () => {
    const { queries } = run({ networks: ['base', 'arbitrum'] })

    expect(queries).toEqual([
      `tsx script/deploy/query-deployment-logs.ts filter --env production ` +
        `--contract ${CONTRACT} --version ${VERSION} ` +
        `--limit 1000 --no-use-cache --format json`,
    ])
  })

  it('exits 0 without verifying when the deployed record is already verified', () => {
    const { status, output, verifies, updates } = run({
      networks: ['base'],
      records: [record('base', ADDRESS_A, { verified: true })],
      deployments: { base: { [CONTRACT]: ADDRESS_A } },
    })

    expect(status).toBe(0)
    expect(output).toContain('verified, flagged or skipped')
    expect(verifies).toEqual([])
    expect(updates).toEqual([])
  })

  it('passes the compiler settings the record was deployed with', () => {
    const { status, verifies } = run({
      networks: ['base'],
      records: [
        record('base', ADDRESS_A, {
          solcVersion: '0.8.17',
          evmVersion: 'london',
          optimizerRuns: '200',
        }),
      ],
      deployments: { base: { [CONTRACT]: ADDRESS_A } },
    })

    expect(status).toBe(0)
    expect(verifies).toEqual([
      verifyCall('base', ADDRESS_A, '0.8.17 london 200'),
    ])
  })

  it('verifies only the deployed address and warns about a stale unverified record', () => {
    const { status, verifies, updates, output } = run({
      networks: ['base'],
      records: [record('base', ADDRESS_A_UPPER), record('base', STALE_ADDRESS)],
      deployments: { base: { [CONTRACT]: ADDRESS_A } },
    })

    expect(status).toBe(0)
    expect(verifies).toEqual([verifyCall('base', ADDRESS_A)])
    expect(updates).toEqual([markCall('base', ADDRESS_A_UPPER)])
    expect(output).toContain(STALE_ADDRESS)
  })

  it('verifies once and flags each spelling when one address has two records', () => {
    const { status, verifies, updates } = run({
      networks: ['base'],
      records: [record('base', ADDRESS_A), record('base', ADDRESS_A_UPPER)],
      deployments: { base: { [CONTRACT]: ADDRESS_A } },
    })

    expect(status).toBe(0)
    expect(verifies).toEqual([verifyCall('base', ADDRESS_A)])
    expect(updates).toEqual(
      [markCall('base', ADDRESS_A), markCall('base', ADDRESS_A_UPPER)].sort()
    )
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
    expect(verifies).toEqual([verifyCall('base', ADDRESS_A)])
    expect(updates).toEqual([markCall('base', ADDRESS_A, 'staging')])
  })
})

describe('verifyRolloutContracts missing records', () => {
  it('fails on a network with no record of the version, after processing the rest', () => {
    const { status, output, verifies } = run({
      networks: ['base', 'optimism'],
      records: [record('base', ADDRESS_A)],
      deployments: {
        base: { [CONTRACT]: ADDRESS_A },
        optimism: { [CONTRACT]: ADDRESS_C },
      },
    })

    expect(status).not.toBe(0)
    expect(verifies).toEqual([verifyCall('base', ADDRESS_A)])
    expect(output).toMatch(/optimism: no 1\.2\.0 record/)
  })

  it('fails when no record sits at the deployment-file address', () => {
    const { status, verifies, updates } = run({
      networks: ['arbitrum'],
      records: [record('arbitrum', STALE_ADDRESS)],
      deployments: { arbitrum: { [CONTRACT]: ADDRESS_B } },
    })

    expect(status).not.toBe(0)
    expect(verifies).toEqual([])
    expect(updates).toEqual([])
  })

  it('fails when the deployment file has no address for the contract', () => {
    const { status, output, verifies } = run({
      networks: ['base'],
      records: [record('base', ADDRESS_A)],
      deployments: { base: { OtherFacet: ADDRESS_A } },
    })

    expect(status).not.toBe(0)
    expect(output).toContain('no AcrossFacetV3 address in deployment file')
    expect(verifies).toEqual([])
  })
})

describe('verifyRolloutContracts exclusion gate', () => {
  it('reports excluded and Tron networks as skipped and never verifies them', () => {
    const { status, verifies, updates, output } = run({
      networks: ['gnosis', 'tron', 'base'],
      excluded: 'somechain,gnosis',
      records: [
        record('gnosis', ADDRESS_A),
        record('tron', ADDRESS_C),
        record('base', ADDRESS_B),
      ],
      deployments: {
        gnosis: { [CONTRACT]: ADDRESS_A },
        tron: { [CONTRACT]: ADDRESS_C },
        base: { [CONTRACT]: ADDRESS_B },
      },
    })

    expect(status).toBe(0)
    expect(output).toMatch(/gnosis.*excluded/)
    expect(output).toMatch(/tron.*excluded/)
    expect(verifies).toEqual([verifyCall('base', ADDRESS_B)])
    expect(updates).toEqual([markCall('base', ADDRESS_B)])
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
  })

  it('fails on empty query output', () => {
    const { status, verifies } = run({ networks: ['base'], rawQueryOutput: '' })

    expect(status).not.toBe(0)
    expect(verifies).toEqual([])
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
    expect(updates).toEqual([markCall('base', ADDRESS_A)])
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
      maxConcurrentJobs: '1',
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
      markCall('arbitrum', ADDRESS_B),
      markCall('optimism', ADDRESS_C),
    ])
    expect(output).toContain(`base: ${ADDRESS_A} (explorer verification)`)
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
      markCall('arbitrum', ADDRESS_B),
      markCall('base', ADDRESS_A),
    ])
    expect(output).toContain(`base: ${ADDRESS_A} (MongoDB verified flag)`)
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

  it('rejects a network missing from networks.json before querying', () => {
    const { status, output, queries } = run({ networks: ['base', 'arbitrm'] })

    expect(status).not.toBe(0)
    expect(output).toContain('arbitrm')
    expect(queries).toEqual([])
  })

  it('rejects a non-numeric MAX_CONCURRENT_JOBS before querying', () => {
    const { status, queries } = run({
      networks: ['base'],
      maxConcurrentJobs: 'abc',
    })

    expect(status).not.toBe(0)
    expect(queries).toEqual([])
  })
})
