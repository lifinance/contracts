/**
 * Tests for the production deploy gate applied by `proposeDiamondCut`.
 *
 * The gate is exercised through a probe process rather than in-process: it reads the
 * repository at `process.cwd()`, so each case needs its own throwaway git repo.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const FACET = 'AllBridgeFacet'
const FACET_PATH = `src/Facets/${FACET}.sol`

const PROBE = `
import { proposeDiamondCut } from ${JSON.stringify(
  join(import.meta.dir, 'propose-diamond-cut')
)}
try {
  await proposeDiamondCut({
    facetName: ${JSON.stringify(FACET)},
    facetAddressHex: '0x0000000000000000000000000000000000000001',
    diamondAddress: 'TXXXX',
    network: process.argv[2],
  })
  console.log('GATE_NOT_REACHED')
} catch (error) {
  const message = (error as Error).message
  console.log(message.includes('deploy gate') ? 'GATE_BLOCKED' : 'GATE_PASSED')
}
`

/**
 * Builds a repo whose tree matches `origin/main`, then optionally diverges the facet.
 * @param diverge - append an unmerged edit to the facet source
 * @returns the repository root
 */
function makeRepo(diverge: boolean): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cut-gate-'))
  const run = (...args: string[]) =>
    spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

  // a real bare origin, because the gate refreshes origin/main before reading it
  const remote = mkdtempSync(join(tmpdir(), 'cut-gate-remote-'))
  spawnSync('git', ['init', '--bare', '-b', 'main', remote])
  run('init', '-b', 'main')
  run('config', 'user.email', 'gate@example.com')
  run('config', 'user.name', 'gate')
  run('remote', 'add', 'origin', remote)
  mkdirSync(join(repoRoot, 'src/Facets'), { recursive: true })
  mkdirSync(join(repoRoot, 'audit'), { recursive: true })
  // the @custom:version tag is load-bearing: the gate reads it off the source before
  // it can look the facet up in the audit log
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

  // a real forge artifact, so the encoder would succeed if it were ever reached - without
  // it the "gate runs before anything is encoded" assertion could never fail
  mkdirSync(join(repoRoot, `out/${FACET}.sol`), { recursive: true })
  writeFileSync(
    join(repoRoot, `out/${FACET}.sol/${FACET}.json`),
    JSON.stringify({ methodIdentifiers: { 'swap(uint256)': 'aabbccdd' } })
  )

  if (diverge)
    writeFileSync(
      join(repoRoot, FACET_PATH),
      `// SPDX-License-Identifier: LGPL-3.0-only\n/// @custom:version 1.0.0\ncontract ${FACET} { uint256 public unreviewed; }\n`
    )

  return repoRoot
}

/**
 * Runs the probe against a throwaway repo.
 * @param options - repo divergence, target network, and PRODUCTION flag
 * @returns the marker the probe printed
 */
function runProbe(options: {
  diverge: boolean
  network: string
  production: string
}): { marker: string; encoded: boolean } {
  const repoRoot = makeRepo(options.diverge)
  const probe = join(repoRoot, 'probe.ts')
  writeFileSync(probe, PROBE)

  // bun, not `bunx tsx`: the probe's cwd is a bare temp repo, where tsx's resolver
  // cannot load @lifi/tron-devkit's exports map
  const result = spawnSync('bun', [probe, options.network], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PRODUCTION: options.production },
  })

  const output = `${result.stdout}${result.stderr}`

  return {
    marker: /GATE_(BLOCKED|PASSED|NOT_REACHED)/.exec(output)?.[0] ?? '',
    // encodeDiamondCutCalldata announces itself, so this proves whether anything was
    // encoded - without it, "the gate runs first" only holds because the fixture has
    // no forge artifact for the encoder to find
    encoded: output.includes('Encoding diamondCut'),
  }
}

describe('proposeDiamondCut deploy gate', () => {
  // this funnel is the only path by which a Tron facet addition reaches a production
  // Safe, and it used to propose with no comparison against main at all
  it('blocks a production cut whose facet diverges from origin/main', () => {
    const result = runProbe({
      diverge: true,
      network: 'tron',
      production: 'true',
    })

    expect(result.marker).toBe('GATE_BLOCKED')
    // the gate has to run before the cut is encoded, not merely before it is proposed
    expect(result.encoded).toBe(false)
  })

  it('allows a production cut whose facet matches origin/main', () => {
    expect(
      runProbe({ diverge: false, network: 'tron', production: 'true' }).marker
    ).toBe('GATE_PASSED')
  })

  // same two exemptions the shell gate in diamondUpdateFacet.sh applies
  it.each([
    ['tronshasta', 'true', 'a testnet'],
    ['tron', 'false', 'staging'],
  ])('skips the gate on %s with PRODUCTION=%s (%s)', (network, production) => {
    expect(runProbe({ diverge: true, network, production }).marker).toBe(
      'GATE_PASSED'
    )
  })
})
