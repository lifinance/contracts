/**
 * What `updateDiamondLogs` writes back for entries it did not change.
 *
 * Drives the real `saveDiamondFacets` and `saveDiamondPeriphery` from
 * `script/helperFunctions.sh` with MongoDB and RPC stubbed and a temp diamond
 * file, so these cases pin which version a regenerated facet entry carries and
 * that a periphery sync keeps the key order the diamond file already has.
 */
import { spawnSync } from 'child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { withholdCredentials } from '../deploy/safe/spawn-env'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const HELPERS = join(REPO_ROOT, 'script', 'helperFunctions.sh')
const TIMEOUT_MS = 30_000

const DIAMOND_CUT = '0xf7993A8df974AD022647E63402d6315137c58ABf'
const LOUPE = '0x7a8d2d9E2B6aDd2D1a5A1E7f7a7E0e5D6dC2b1a3'
const SWAP = '0x31a9b1835864706Af10103b31Ea2b79bdb995F5F'

let sandbox: string

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'update-diamond-logs-'))
  for (const link of ['script', 'config'])
    symlinkSync(join(REPO_ROOT, link), join(sandbox, link))
  mkdirSync(join(sandbox, 'deployments'))
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

/**
 * Loads the real helper definitions without their top-level side effects: a
 * function named `source` shadows the builtin that pulls in `.env` and the
 * sibling scripts, while `.` still loads the helpers file itself.
 */
const LOAD_HELPERS = `
  source() { return 0; }
  getZkToolchainPin() { echo ""; }
  . "$HELPERS"
`

const runHarness = (body: string, extraEnv: Record<string, string> = {}) => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HELPERS,
    ...extraEnv,
  }
  withholdCredentials(env)
  return spawnSync('bash', ['-c', body], {
    cwd: sandbox,
    encoding: 'utf8',
    env,
    timeout: TIMEOUT_MS,
  })
}

interface IBatchRow {
  address: string
  contractName: string
  version?: string
}

type FacetLog = Record<string, { Name: string; Version: string }>

/**
 * Regenerates the facets of `fuse.diamond.json` from a stubbed batch answer.
 * @param existing - Facets the diamond file holds before the run
 * @param rows - Production deployment-log rows the batch query returns
 * @returns The Facets object written back to the diamond file
 */
const regenerate = (existing: FacetLog, rows: IBatchRow[]): FacetLog => {
  const diamondFile = join(sandbox, 'deployments', 'fuse.diamond.json')
  writeFileSync(
    diamondFile,
    JSON.stringify({ LiFiDiamond: { Facets: existing, Periphery: {} } })
  )
  const batch = rows.map(({ address, ...data }) => ({
    id: `${address}::production`,
    found: true,
    data,
  }))
  const result = runHarness(
    `
    ${LOAD_HELPERS}
    echoDebug() { :; }
    warning() { echo "[warning] $*"; }
    error() { echo "[error] $*"; }
    isTronNetwork() { return 1; }
    isMongoLoggingEnabled() { return 0; }
    batchQueryMongoDeployments() { printf '%s' "$BATCH"; }
    findContractInMasterLogByAddress() { echo "UNEXPECTED_LOOKUP $*" >&2; return 1; }
    getContractNameFromDeploymentLogs() { echo "UNEXPECTED_LOOKUP $*" >&2; return 1; }
    saveDiamondPeriphery() { :; }
    saveDiamondFacets fuse production true "[${rows
      .map((r) => r.address)
      .join(',')}]"
    echo "rc=$?"
  `,
    { BATCH: JSON.stringify(batch) }
  )
  const out = `${result.stdout}${result.stderr}`
  expect(out).toContain('rc=0')
  expect(out).not.toContain('UNEXPECTED_LOOKUP')
  return JSON.parse(readFileSync(diamondFile, 'utf8')).LiFiDiamond.Facets
}

describe('saveDiamondFacets from the batch deployment-log query', () => {
  it(
    'keeps the diamond file version when the deployment-log row has none',
    () => {
      const facets = regenerate(
        {
          [DIAMOND_CUT]: { Name: 'DiamondCutFacet', Version: '1.0.0' },
          [LOUPE]: { Name: 'DiamondLoupeFacet', Version: '1.0.0' },
        },
        [
          { address: DIAMOND_CUT, contractName: 'DiamondCutFacet' },
          { address: LOUPE, contractName: 'DiamondLoupeFacet', version: '' },
        ]
      )
      expect(facets[DIAMOND_CUT]).toEqual({
        Name: 'DiamondCutFacet',
        Version: '1.0.0',
      })
      expect(facets[LOUPE]).toEqual({
        Name: 'DiamondLoupeFacet',
        Version: '1.0.0',
      })
    },
    TIMEOUT_MS
  )

  it(
    'writes an empty version for an address the diamond file does not hold',
    () => {
      const facets = regenerate({}, [
        { address: DIAMOND_CUT, contractName: 'DiamondCutFacet', version: '' },
      ])
      expect(facets[DIAMOND_CUT]).toEqual({
        Name: 'DiamondCutFacet',
        Version: '',
      })
    },
    TIMEOUT_MS
  )

  it(
    "takes the deployment log's version over the diamond file's",
    () => {
      const facets = regenerate(
        { [SWAP]: { Name: 'GenericSwapFacetV3', Version: '1.0.1' } },
        [
          {
            address: SWAP,
            contractName: 'GenericSwapFacetV3',
            version: '2.0.0',
          },
        ]
      )
      expect(facets[SWAP]).toEqual({
        Name: 'GenericSwapFacetV3',
        Version: '2.0.0',
      })
    },
    TIMEOUT_MS
  )
})

type PeripheryLog = Record<string, string>

/**
 * Regenerates the periphery of `fuse.diamond.json` from stubbed on-chain lookups.
 * @param existing - Periphery the diamond file holds before the run
 * @param folderOrder - Names in the order the `src/Periphery` glob yields them
 * @param onChain - Address `getPeripheryContract` returns for each name
 * @returns The Periphery keys and values written back, in file order
 */
const regeneratePeriphery = (
  existing: PeripheryLog,
  folderOrder: string[],
  onChain: PeripheryLog
): [string, string][] => {
  const diamondFile = join(sandbox, 'deployments', 'fuse.diamond.json')
  writeFileSync(
    diamondFile,
    JSON.stringify({ LiFiDiamond: { Facets: {}, Periphery: existing } })
  )
  const result = runHarness(
    `
    ${LOAD_HELPERS}
    echoDebug() { :; }
    warning() { echo "[warning] $*"; }
    error() { echo "[error] $*"; }
    isTronNetwork() { return 1; }
    getRPCUrl() { echo "http://stub"; }
    getContractAddressFromDeploymentLogs() { echo "${DIAMOND_CUT}"; }
    getContractNamesInFolder() { echo "$FOLDER_ORDER"; }
    universalCast() { echo "$ON_CHAIN" | jq -r --arg n "$5" '.[$n]'; }
    saveDiamondPeriphery fuse production true
    echo "rc=$?"
  `,
    { FOLDER_ORDER: folderOrder.join(' '), ON_CHAIN: JSON.stringify(onChain) }
  )
  const out = `${result.stdout}${result.stderr}`
  expect(out).toContain('rc=0')
  expect(out).not.toContain('[warning]')
  return Object.entries(
    JSON.parse(readFileSync(diamondFile, 'utf8')).LiFiDiamond
      .Periphery as PeripheryLog
  )
}

const EXECUTOR = '0x2dfaDAB8266483beD9Fd9A292Ce56596a2D1378D'
const DEX_AGGREGATOR = '0x6140b987d6B51Fd75b66C3B07733Beb5167c42fc'
const LIDO_WRAPPER = '0x462A9B6879770050021823D63aE62470E65Af8D8'
const ON_CHAIN = {
  Executor: EXECUTOR,
  LiFiDEXAggregator: DEX_AGGREGATOR,
  LidoWrapper: LIDO_WRAPPER,
}

describe('saveDiamondPeriphery key order', () => {
  it(
    'keeps the order the diamond file has whatever order the folder yields',
    () => {
      const entries = regeneratePeriphery(
        { LidoWrapper: '', LiFiDEXAggregator: '', Executor: '' },
        ['Executor', 'LiFiDEXAggregator', 'LidoWrapper'],
        ON_CHAIN
      )
      expect(entries).toEqual([
        ['LidoWrapper', LIDO_WRAPPER],
        ['LiFiDEXAggregator', DEX_AGGREGATOR],
        ['Executor', EXECUTOR],
      ])
    },
    TIMEOUT_MS
  )

  it(
    'adds names the diamond file lacks after the existing ones, in byte order',
    () => {
      const entries = regeneratePeriphery(
        { LidoWrapper: LIDO_WRAPPER },
        ['LidoWrapper', 'LiFiDEXAggregator', 'Executor'],
        ON_CHAIN
      )
      expect(entries.map(([name]) => name)).toEqual([
        'LidoWrapper',
        'Executor',
        'LiFiDEXAggregator',
      ])
    },
    TIMEOUT_MS
  )

  it(
    'drops names no longer in the folder and byte-orders a fresh file',
    () => {
      const entries = regeneratePeriphery(
        { Deprecated: EXECUTOR },
        ['LidoWrapper', 'LiFiDEXAggregator'],
        ON_CHAIN
      )
      expect(entries.map(([name]) => name)).toEqual([
        'LiFiDEXAggregator',
        'LidoWrapper',
      ])
    },
    TIMEOUT_MS
  )
})
