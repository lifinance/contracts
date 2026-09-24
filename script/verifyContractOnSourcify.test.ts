/**
 * Tests for verifyContractOnSourcify (script/helperFunctions.sh): which networks
 * it skips, that forge is steered to Sourcify even when an explorer key is set,
 * and that Sourcify's lookup API (checked first, then polled while the job runs)
 * decides success. Also covers verifyContract running the Sourcify step after
 * the explorer. forge is a PATH stub; curl, sleep and the network lookups are
 * shell functions.
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
const UNSUPPORTED_CHAIN =
  '400|{"customCode":"unsupported_chain","message":"not supported"}'

interface IRun {
  status: number | null
  output: string
  forgeCalls: string[]
  curlCalls: number
  explorerCalls: string[]
}

/**
 * Runs `fn` (verifyContractOnSourcify or verifyContract) with stubbed forge and
 * curl. `lookups` are the Sourcify lookup responses, one per request (the last
 * repeats), each `STATUS` or `STATUS|BODY`. For verifyContract the explorer
 * step is stubbed to return `explorerStatus`.
 */
function run(params: {
  network: string
  lookups: string[]
  fn?: 'verifyContractOnSourcify' | 'verifyContract'
  args?: string[]
  foundryProfile?: string
  explorerStatus?: number
  excludedNetworks?: string
}): IRun {
  const dir = mkdtempSync(join(tmpdir(), 'sourcify-helper-'))
  const forgeLog = join(dir, 'forge.log')
  const curlLog = join(dir, 'curl.log')
  const explorerLog = join(dir, 'explorer.log')
  const lookups = join(dir, 'lookups')
  writeFileSync(forgeLog, '')
  writeFileSync(curlLog, '')
  writeFileSync(explorerLog, '')
  writeFileSync(lookups, `${params.lookups.join('\n')}\n`)
  const forge = join(dir, 'forge')
  writeFileSync(
    forge,
    // Records only whether each key is non-empty: helperFunctions.sh sources
    // the repo .env, so the values here can be real explorer keys.
    `#!/bin/bash\necho "key=[\${MAINNET_ETHERSCAN_API_KEY:+set}] global=[\${ETHERSCAN_API_KEY:+set}\${FOUNDRY_ETHERSCAN_API_KEY:+set}] profile=[\${FOUNDRY_PROFILE:-}] $*" >> "${forgeLog}"\n`
  )
  chmodSync(forge, 0o755)

  const harness = `
    source script/helperFunctions.sh >/dev/null 2>&1
    DO_NOT_VERIFY_IN_THESE_NETWORKS="${params.excludedNetworks ?? ''}"
    ${
      params.foundryProfile
        ? `export FOUNDRY_PROFILE=${params.foundryProfile}`
        : 'unset FOUNDRY_PROFILE'
    }
    isTestnetNetwork() { [[ "$1" == "testnet" ]]; }
    isZkEvmNetwork() { [[ "$1" == "zk" ]]; }
    getVerifierUrlFromFoundryToml() {
      case "$1" in
      telos) echo "https://sourcify.dev/server" ;;
      tempo) echo "https://contracts.tempo.xyz" ;;
      *) echo "https://api.etherscan.io/v2/api?chainid=1" ;;
      esac
    }
    getChainId() { echo 1; }
    getContractFilePath() { echo "src/Facets/DiamondCutFacet.sol"; }
    getEtherscanApiKeyName() { echo "MAINNET_ETHERSCAN_API_KEY"; }
    verifyContractOnExplorer() {
      echo "$*" >> "${explorerLog}"
      return ${params.explorerStatus ?? 0}
    }
    warning() { echo "[warning] $*"; }
    sleep() { :; }
    curl() {
      echo "$*" >> "${curlLog}"
      local N LINES ENTRY
      N=$(wc -l < "${curlLog}")
      LINES=$(wc -l < "${lookups}")
      [[ $N -gt $LINES ]] && N=$LINES
      ENTRY=$(sed -n "\${N}p" "${lookups}")
      printf '%s\\n%s' "\${ENTRY#*|}" "\${ENTRY%%|*}"
    }
    ${params.fn ?? 'verifyContractOnSourcify'} "$@"
  `

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  }
  withholdCredentials(env)
  env.PATH = `${dir}:${process.env.PATH ?? ''}`
  env.MAINNET_ETHERSCAN_API_KEY = 'dummy-explorer-key'
  env.ETHERSCAN_API_KEY = 'dummy-global-key'
  env.FOUNDRY_ETHERSCAN_API_KEY = 'dummy-foundry-key'

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
        ...(params.args ?? ['']),
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env }
    )
    const lines = (file: string): string[] =>
      readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      forgeCalls: lines(forgeLog),
      curlCalls: lines(curlLog).length,
      explorerCalls: lines(explorerLog),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('verifyContractOnSourcify', () => {
  it.each(['testnet', 'zk', 'telos'])(
    'skips %s without calling forge or Sourcify',
    (network) => {
      const result = run({ network, lookups: ['404'] })

      expect(result.status).toBe(0)
      expect(result.forgeCalls).toHaveLength(0)
      expect(result.curlCalls).toBe(0)
    }
  )

  it('submits tempo, whose explorer is its own Sourcify instance', () => {
    const result = run({ network: 'tempo', lookups: ['404', '200'] })

    expect(result.status).toBe(0)
    expect(result.forgeCalls).toHaveLength(1)
    expect(result.forgeCalls[0]).toContain(
      '--verifier-url https://sourcify.dev/server'
    )
  })

  it('returns without submitting when Sourcify already verifies it', () => {
    const result = run({ network: 'arbitrum', lookups: ['200'] })

    expect(result.status).toBe(0)
    expect(result.forgeCalls).toHaveLength(0)
    expect(result.curlCalls).toBe(1)
    expect(result.output).toContain('already verified on Sourcify')
  })

  it('returns without submitting when Sourcify does not support the chain', () => {
    const result = run({ network: 'somnia', lookups: [UNSUPPORTED_CHAIN] })

    expect(result.status).toBe(0)
    expect(result.forgeCalls).toHaveLength(0)
    expect(result.curlCalls).toBe(1)
    expect(result.output).toContain('Sourcify does not support somnia')
  })

  it('treats a 400 without the unsupported_chain code as unverified', () => {
    const result = run({
      network: 'arbitrum',
      lookups: ['400|{"customCode":"invalid_address"}'],
    })

    expect(result.status).toBe(1)
    expect(result.forgeCalls).toHaveLength(1)
    expect(result.output).toContain('HTTP 400')
  })

  it('submits with every explorer key blanked and waits for the job', () => {
    const result = run({
      network: 'arbitrum',
      args: ['0x' + '00'.repeat(32)],
      lookups: ['404', '404', '404', '200'],
    })

    expect(result.status).toBe(0)
    expect(result.forgeCalls).toHaveLength(1)
    const call = result.forgeCalls[0] ?? ''
    expect(call).toStartWith(
      'key=[] global=[] profile=[] verify-contract --verifier sourcify'
    )
    expect(call).toContain(
      `--chain-id 1 ${ADDRESS} src/Facets/DiamondCutFacet.sol:DiamondCutFacet`
    )
    expect(call).toContain(`--constructor-args 0x${'00'.repeat(32)}`)
    expect(result.curlCalls).toBe(4)
    expect(result.output).toContain('verified on Sourcify')
  })

  it('omits constructor args that are not ABI-encoded hex', () => {
    const result = run({
      network: 'arbitrum',
      args: ['not-hex'],
      lookups: ['404', '200'],
    })

    expect(result.status).toBe(0)
    expect(result.forgeCalls[0]).not.toContain('--constructor-args')
  })

  it('passes the recorded toolchain and the active profile to forge', () => {
    const result = run({
      network: 'mantle',
      args: ['', '0.8.17', 'london', '1000000'],
      foundryProfile: 'london',
      lookups: ['404'],
    })

    const call = result.forgeCalls[0] ?? ''
    expect(call).toContain('profile=[london]')
    expect(call).toContain(
      '--compiler-version 0.8.17 --evm-version london --num-of-optimizations 1000000'
    )
    expect(result.output).toContain(
      'Retry with: env -u ETHERSCAN_API_KEY -u FOUNDRY_ETHERSCAN_API_KEY FOUNDRY_PROFILE=london MAINNET_ETHERSCAN_API_KEY= forge verify-contract'
    )
  })

  it('warns and returns 1 when Sourcify never verifies the contract', () => {
    const result = run({ network: 'arbitrum', lookups: ['404'] })

    expect(result.status).toBe(1)
    expect(result.curlCalls).toBe(7)
    expect(result.output).toContain('is not verified on Sourcify')
    expect(result.output).toContain('HTTP 404')
    expect(result.output).toContain('leave arbitrum out of the registry')
    expect(result.output).not.toContain('FOUNDRY_PROFILE=')
  })
})

describe('verifyContract', () => {
  it('submits to Sourcify after a successful explorer verification', () => {
    const result = run({
      fn: 'verifyContract',
      network: 'arbitrum',
      lookups: ['404', '200'],
    })

    expect(result.status).toBe(0)
    expect(result.explorerCalls).toHaveLength(1)
    expect(result.forgeCalls).toHaveLength(1)
  })

  it('still submits to Sourcify and returns the explorer failure', () => {
    const result = run({
      fn: 'verifyContract',
      network: 'arbitrum',
      explorerStatus: 1,
      lookups: ['404', '200'],
    })

    expect(result.status).toBe(1)
    expect(result.forgeCalls).toHaveLength(1)
  })

  it('returns the explorer result when Sourcify fails', () => {
    const result = run({
      fn: 'verifyContract',
      network: 'arbitrum',
      lookups: ['404'],
    })

    expect(result.status).toBe(0)
    expect(result.output).toContain('is not verified on Sourcify')
  })

  it('verifies nowhere on an excluded network', () => {
    const result = run({
      fn: 'verifyContract',
      network: 'arbitrum',
      excludedNetworks: 'bsc,arbitrum',
      lookups: ['404'],
    })

    expect(result.status).toBe(1)
    expect(result.explorerCalls).toHaveLength(0)
    expect(result.forgeCalls).toHaveLength(0)
    expect(result.curlCalls).toBe(0)
  })
})
