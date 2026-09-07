/**
 * Placement proof for the funnel deploy gate: it has to refuse inside
 * `propose-to-safe.ts` itself, not merely be importable and correct.
 *
 * Each case runs the real CLI in a throwaway git repo, so the gate reads a tree
 * it can actually diverge. `getDeployments` resolves its path from the module
 * rather than the cwd, so address attribution still comes from this repo's real
 * production log — which is why the facet address is read out of it here.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from './constants'

const FACET = 'AllBridgeFacet'
const FACET_PATH = `src/Facets/${FACET}.sol`
const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const PROPOSE_CLI = join(REPO_ROOT, 'script/deploy/safe/propose-to-safe.ts')

const deployments = JSON.parse(
  readFileSync(join(REPO_ROOT, 'deployments/mainnet.json'), 'utf8')
) as Record<string, string>
const FACET_ADDRESS = deployments[FACET] as Address
const DIAMOND_ADDRESS = deployments.LiFiDiamond as Address

const ADD_CUT = encodeFunctionData({
  abi: DIAMOND_CUT_ABI,
  functionName: 'diamondCut',
  args: [
    [
      {
        facetAddress: FACET_ADDRESS,
        action: 0,
        functionSelectors: ['0xaabbccdd'] as Hex[],
      },
    ],
    ZERO_ADDRESS as Address,
    '0x' as Hex,
  ],
})

/**
 * Builds a repo whose tree matches `origin/main`, then optionally diverges the facet.
 * @param diverge - append an unmerged edit to the facet source
 * @returns the repository root
 */
const makeRepo = (diverge: boolean): string => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'funnel-gate-'))
  const run = (...args: string[]) =>
    spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

  // a real bare origin, because the gate refreshes origin/main before reading it
  const remote = mkdtempSync(join(tmpdir(), 'funnel-gate-remote-'))
  spawnSync('git', ['init', '--bare', '-b', 'main', remote])
  run('init', '-b', 'main')
  run('config', 'user.email', 'gate@example.com')
  run('config', 'user.name', 'gate')
  run('remote', 'add', 'origin', remote)
  mkdirSync(join(repoRoot, 'src/Facets'), { recursive: true })
  mkdirSync(join(repoRoot, 'audit'), { recursive: true })
  // the @custom:version tag is load-bearing: the gate reads it off the source
  // before it can look the facet up in the audit log
  writeFileSync(
    join(repoRoot, FACET_PATH),
    `// SPDX-License-Identifier: LGPL-3.0-only\n/// @custom:version 1.0.0\ncontract ${FACET} {}\n`
  )
  writeFileSync(
    join(repoRoot, 'audit/auditLog.json'),
    JSON.stringify({ audits: {}, auditedContracts: {} })
  )
  run('add', '.')
  run('commit', '-m', 'merged state', '--no-gpg-sign')
  run('push', '-q', 'origin', 'main')

  if (diverge)
    writeFileSync(
      join(repoRoot, FACET_PATH),
      `// SPDX-License-Identifier: LGPL-3.0-only\n/// @custom:version 1.0.0\ncontract ${FACET} { uint256 public unreviewed; }\n`
    )

  return repoRoot
}

/**
 * Runs the real propose CLI against a throwaway repo.
 * @param options - repo divergence, target network, and the calldata to propose
 * @returns the CLI's combined output and exit status
 */
const runCli = (options: {
  diverge: boolean
  network: string
  calldata: Hex
  env?: Record<string, string>
}): { output: string; status: number | null } => {
  const repoRoot = makeRepo(options.diverge)
  const result = spawnSync(
    'bun',
    [
      PROPOSE_CLI,
      '--network',
      options.network,
      '--to',
      DIAMOND_ADDRESS,
      '--calldata',
      options.calldata,
      '--timelock',
      '--ticket',
      'EXSC-704',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ENVIRONMENT: options.env?.ENVIRONMENT ?? 'production',
        // never reach a real Safe, a real RPC or a real Mongo from a test
        PRIVATE_KEY_PRODUCTION: '',
        MONGODB_URI: '',
        ...options.env,
      },
    }
  )
  return {
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  }
}

const GATE_REFUSAL = /Production deploy gate failed/

describe('propose-to-safe funnel deploy gate', () => {
  it('refuses a diverged facet addition before the Safe client is initialised', () => {
    const result = runCli({
      diverge: true,
      network: 'mainnet',
      calldata: ADD_CUT,
    })

    expect(result.output).toMatch(GATE_REFUSAL)
    expect(result.output).toContain(FACET)
    expect(result.status).not.toBe(0)
    // the refusal has to land before anything is signed or stored
    expect(result.output).not.toContain('Signer Address')
    expect(result.output).not.toContain('Using timelock controller')
  })

  it('lets an unchanged facet addition past the gate', () => {
    const result = runCli({
      diverge: false,
      network: 'mainnet',
      calldata: ADD_CUT,
    })

    expect(result.output).not.toMatch(GATE_REFUSAL)
    expect(result.output).toContain('Production deploy gate passed')
  })

  it('skips the gate on a testnet even with a diverged facet', () => {
    const result = runCli({
      diverge: true,
      network: 'sepolia',
      calldata: ADD_CUT,
    })

    expect(result.output).not.toMatch(GATE_REFUSAL)
    expect(result.output).not.toContain('Production deploy gate passed')
  })

  it('skips the gate for staging even with a diverged facet', () => {
    const result = runCli({
      diverge: true,
      network: 'mainnet',
      calldata: ADD_CUT,
      env: { ENVIRONMENT: 'staging' },
    })

    expect(result.output).not.toMatch(GATE_REFUSAL)
  })

  it('does not gate a proposal that installs no facet code', () => {
    const result = runCli({
      diverge: true,
      network: 'mainnet',
      calldata: '0xdeadbeef' as Hex,
    })

    expect(result.output).not.toMatch(GATE_REFUSAL)
    expect(result.output).not.toContain('Production deploy gate passed')
  })
})
