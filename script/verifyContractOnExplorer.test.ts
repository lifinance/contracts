/**
 * Tests the forge command verifyContractOnExplorer (script/helperFunctions.sh)
 * builds from the real config/networks.json and foundry.toml for the networks
 * typed `oklink` and `blockscout`. forge is a PATH stub that records its argv.
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
const OKLINK_URL =
  'https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin'

interface IRun {
  status: number | null
  output: string
  forgeCalls: string[]
}

/**
 * Runs verifyContractOnExplorer for `network`. `keys` are assigned after
 * helperFunctions.sh has sourced the repo .env, so they replace its values.
 */
function run(network: string, keys: Record<string, string>): IRun {
  const dir = mkdtempSync(join(tmpdir(), 'explorer-verify-'))
  const forgeLog = join(dir, 'forge.log')
  writeFileSync(forgeLog, '')
  const forge = join(dir, 'forge')
  writeFileSync(
    forge,
    `#!/bin/bash\necho "$*" >> "${forgeLog}"\necho "Contract successfully verified"\n`
  )
  chmodSync(forge, 0o755)

  const assignments = Object.entries(keys)
    .map(([name, value]) => `export ${name}="${value}"`)
    .join('\n')
  const harness = `
    source script/helperFunctions.sh >/dev/null 2>&1
    FOUNDRY_TOML_FILE_PATH="foundry.toml"
    NETWORKS_JSON_FILE_PATH="config/networks.json"
    MAX_ATTEMPTS_PER_CONTRACT_VERIFICATION=1
    ${assignments}
    getContractFilePath() { echo "src/Facets/DiamondCutFacet.sol"; }
    verifyContractOnExplorer "$@"
  `

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  }
  withholdCredentials(env)
  env.PATH = `${dir}:${process.env.PATH ?? ''}`

  try {
    const result = spawnSync(
      'bash',
      ['-c', harness, 'harness', network, 'DiamondCutFacet', ADDRESS, ''],
      { cwd: REPO_ROOT, encoding: 'utf8', env }
    )
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      forgeCalls: readFileSync(forgeLog, 'utf8').split('\n').filter(Boolean),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('verifyContractOnExplorer', () => {
  it('sends xlayer to OKLink without a key when none is configured', () => {
    const result = run('xlayer', { NO_ETHERSCAN_API_KEY_REQUIRED: '' })

    expect(result.status).toBe(0)
    expect(result.forgeCalls).toHaveLength(1)
    const call = result.forgeCalls[0] ?? ''
    expect(call).toContain('--verifier oklink')
    expect(call).toContain(`--verifier-url ${OKLINK_URL}/xlayer --chain-id 196`)
    expect(call).not.toContain('--verifier-api-key')
    expect(call).not.toContain('--etherscan-api-key')
  })

  it('passes a non-empty NO_ETHERSCAN_API_KEY_REQUIRED as the verifier key', () => {
    const result = run('xlayer', {
      NO_ETHERSCAN_API_KEY_REQUIRED: 'dummy-oklink-key',
    })

    expect(result.status).toBe(0)
    expect(result.forgeCalls[0]).toContain(
      '--verifier oklink --verifier-api-key dummy-oklink-key'
    )
    expect(result.output).not.toContain('dummy-oklink-key')
  })

  it('sends gravity to OKLink with its own key', () => {
    const result = run('gravity', {
      GRAVITY_ETHERSCAN_API_KEY: 'dummy-gravity-key',
    })

    expect(result.status).toBe(0)
    const call = result.forgeCalls[0] ?? ''
    expect(call).toContain(
      '--verifier oklink --verifier-api-key dummy-gravity-key'
    )
    expect(call).toContain(
      `--verifier-url ${OKLINK_URL}/GRAVITY --chain-id 1625`
    )
    expect(call).not.toContain('--etherscan-api-key')
  })

  it('refuses gravity before calling forge when its key is empty', () => {
    const result = run('gravity', { GRAVITY_ETHERSCAN_API_KEY: '' })

    expect(result.status).toBe(1)
    expect(result.forgeCalls).toHaveLength(0)
    expect(result.output).toContain('GRAVITY_ETHERSCAN_API_KEY is empty')
  })

  it('sends immutablezkevm to Blockscout without a key', () => {
    const result = run('immutablezkevm', { NO_ETHERSCAN_API_KEY_REQUIRED: '' })

    expect(result.status).toBe(0)
    const call = result.forgeCalls[0] ?? ''
    expect(call).toContain('--verifier blockscout')
    expect(call).toContain('--chain-id 13371')
    expect(call).not.toContain('api-key')
  })
})
