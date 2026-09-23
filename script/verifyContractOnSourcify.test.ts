/**
 * Tests for verifyContractOnSourcify (script/helperFunctions.sh): which networks
 * it skips, that forge is steered to Sourcify even when the chain has an explorer
 * key, and that Sourcify's lookup API (polled while the job runs) decides success.
 * forge is a PATH stub; curl, sleep and the network lookups are shell functions.
 */
import { spawnSync } from 'child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { withholdCredentials } from './deploy/safe/spawn-env'

const REPO_ROOT = join(import.meta.dir, '..')
const ADDRESS = '0x00000000000000000000000000000000000000a1'

interface IRun {
  status: number | null
  output: string
  forgeCalls: string[]
  curlCalls: number
}

/**
 * Runs verifyContractOnSourcify with stubbed forge/curl. `lookupStatuses` are the
 * HTTP codes the Sourcify lookup returns, one per poll (the last one repeats).
 */
function run(params: {
  network: string
  constructorArgs?: string
  lookupStatuses: string[]
  verificationType?: string
}): IRun {
  const dir = mkdtempSync(join(tmpdir(), 'sourcify-helper-'))
  const forgeLog = join(dir, 'forge.log')
  const curlLog = join(dir, 'curl.log')
  const statuses = join(dir, 'statuses')
  const networksJson = join(dir, 'networks.json')
  writeFileSync(forgeLog, '')
  writeFileSync(curlLog, '')
  writeFileSync(statuses, `${params.lookupStatuses.join('\n')}\n`)
  writeFileSync(
    networksJson,
    JSON.stringify({
      [params.network]: {
        verificationType: params.verificationType ?? 'etherscan',
      },
    })
  )
  const forge = join(dir, 'forge')
  writeFileSync(
    forge,
    // Records only whether the key is non-empty: helperFunctions.sh sources the
    // repo .env, so the value here can be a real explorer key.
    `#!/bin/bash\necho "key=[\${MAINNET_ETHERSCAN_API_KEY:+set}] $*" >> "${forgeLog}"\n`
  )
  chmodSync(forge, 0o755)

  const harness = `
    source script/helperFunctions.sh >/dev/null 2>&1
    NETWORKS_JSON_FILE_PATH="${networksJson}"
    isTestnetNetwork() { [[ "$1" == "testnet" ]]; }
    isZkEvmNetwork() { [[ "$1" == "zk" ]]; }
    getChainId() { echo 1; }
    getContractFilePath() { echo "src/Facets/DiamondCutFacet.sol"; }
    getEtherscanApiKeyName() { echo "MAINNET_ETHERSCAN_API_KEY"; }
    warning() { echo "[warning] $*"; }
    sleep() { :; }
    curl() {
      echo "$*" >> "${curlLog}"
      local N LINES
      N=$(wc -l < "${curlLog}")
      LINES=$(wc -l < "${statuses}")
      [[ $N -gt $LINES ]] && N=$LINES
      sed -n "\${N}p" "${statuses}"
    }
    verifyContractOnSourcify "$@"
  `

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  }
  withholdCredentials(env)
  env.PATH = `${dir}:${process.env.PATH ?? ''}`
  env.MAINNET_ETHERSCAN_API_KEY = 'dummy-explorer-key'

  try {
    const result = spawnSync(
      'bash',
      [
        '-c',
        harness,
        'harness',
        params.network,
        'DiamondCutFacet',
        ADDRESS,
        params.constructorArgs ?? '',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env }
    )
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      forgeCalls: readFileSync(forgeLog, 'utf8').split('\n').filter(Boolean),
      curlCalls: readFileSync(curlLog, 'utf8').split('\n').filter(Boolean)
        .length,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('verifyContractOnSourcify', () => {
  it.each([
    ['testnet', 'etherscan'],
    ['zk', 'etherscan'],
    ['telos', 'sourcify'],
  ])(
    'skips %s (verificationType %s) without calling forge',
    (network, type) => {
      const result = run({
        network,
        verificationType: type,
        lookupStatuses: ['404'],
      })

      expect(result.status).toBe(0)
      expect(result.forgeCalls).toHaveLength(0)
      expect(result.curlCalls).toBe(0)
    }
  )

  it('submits to Sourcify with the explorer key blanked and waits for the job', () => {
    const result = run({
      network: 'arbitrum',
      constructorArgs: '0x' + '00'.repeat(32),
      lookupStatuses: ['404', '404', '200'],
    })

    expect(result.status).toBe(0)
    expect(result.forgeCalls).toHaveLength(1)
    const call = result.forgeCalls[0] ?? ''
    expect(call).toStartWith('key=[] verify-contract --verifier sourcify')
    expect(call).toContain(
      `--chain-id 1 ${ADDRESS} src/Facets/DiamondCutFacet.sol:DiamondCutFacet`
    )
    expect(call).toContain(`--constructor-args 0x${'00'.repeat(32)}`)
    expect(result.curlCalls).toBe(3)
    expect(result.output).toContain('verified on Sourcify')
  })

  it('omits constructor args that are not ABI-encoded hex', () => {
    const result = run({
      network: 'arbitrum',
      constructorArgs: 'not-hex',
      lookupStatuses: ['200'],
    })

    expect(result.status).toBe(0)
    expect(result.forgeCalls[0]).not.toContain('--constructor-args')
  })

  it('warns and returns 1 when Sourcify never verifies the contract', () => {
    const result = run({ network: 'arbitrum', lookupStatuses: ['404'] })

    expect(result.status).toBe(1)
    expect(result.curlCalls).toBe(6)
    expect(result.output).toContain('is not verified on Sourcify')
    expect(result.output).toContain('HTTP 404')
    expect(result.output).toContain('leave arbitrum out of the registry')
  })
})
