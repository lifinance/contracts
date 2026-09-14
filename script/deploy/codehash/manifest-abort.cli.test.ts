// SPDX-License-Identifier: LGPL-3.0-only
/**
 * Spawns the real mint so the abort is observed where it has to happen.
 *
 * `manifestEntryFrom` only labels a refusal; whether the mint stops is the
 * task's decision, and a `disposition` nothing reads would leave every unit
 * test in `build-manifest.test.ts` green while a short manifest still got
 * written.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  afterEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..')
const TASK = 'tasks/buildAttestationManifest.ts'
const SOURCE_DIRS = ['src', 'src/Facets', 'src/Periphery', 'src/Security']
const VERSION_RE = /@custom:version\s+(\S+)/

/**
 * The first contract the mint would look for, found the way the mint finds it.
 *
 * Named rather than hard-coded so a rename surfaces as this test failing to
 * find any candidate, not as it silently exercising a path the mint no longer
 * walks.
 */
const firstVersionedContract = (): { name: string; file: string } => {
  for (const dir of SOURCE_DIRS) {
    const abs = path.join(REPO_ROOT, dir)
    if (!fs.existsSync(abs)) continue
    for (const entry of fs.readdirSync(abs).sort()) {
      if (!entry.endsWith('.sol')) continue
      const source = fs.readFileSync(path.join(abs, entry), 'utf8')
      if (VERSION_RE.test(source))
        return { name: entry.replace(/\.sol$/, ''), file: entry }
    }
  }
  throw new Error('no versioned contract found under the mint source dirs')
}

/** An artifact shaped like a real one, built under a profile that is not default. */
const floorArtifact = (contract: { name: string; file: string }): unknown => ({
  deployedBytecode: { object: `0x${'60'.repeat(40)}` },
  metadata: {
    compiler: { version: '0.8.17+commit.8df45f5f' },
    settings: {
      evmVersion: 'london',
      optimizer: { enabled: true, runs: 1000000 },
      metadata: { bytecodeHash: 'ipfs' },
      libraries: {},
      compilationTarget: { [`src/${contract.file}`]: contract.name },
    },
    sources: {
      [`src/${contract.file}`]: { keccak256: `0x${'ab'.repeat(32)}` },
    },
  },
})

describe('the mint refuses to publish a manifest short by a profile conflict', () => {
  let outDir: string

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true })
  })

  it('exits non-zero naming the artifact, instead of skipping past it', () => {
    const contract = firstVersionedContract()
    outDir = fs.mkdtempSync(path.join(tmpdir(), 'mint-abort-'))
    fs.mkdirSync(path.join(outDir, contract.file), { recursive: true })
    fs.writeFileSync(
      path.join(outDir, contract.file, `${contract.name}.json`),
      JSON.stringify(floorArtifact(contract))
    )

    // `--check` so the run cannot write over the committed manifest: the abort
    // is what is under test, and the failing path is the one being provoked.
    const result = spawnSync(
      'bunx',
      ['tsx', TASK, '--out', outDir, '--check'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

    expect(result.status).not.toBe(0)
    // The abort names the artifact path; the skip listing does not. Asserting
    // the reason alone would pass while the conflict was still a skip.
    expect(output).toContain(
      `${contract.name} (${path.join(
        outDir,
        contract.file,
        `${contract.name}.json`
      )}): artifact was built for evm london`
    )
    expect(output).not.toContain(`Skipped`)
  })
})
