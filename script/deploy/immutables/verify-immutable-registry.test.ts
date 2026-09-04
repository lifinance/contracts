/**
 * Unit and CLI tests for the registry gate's entry point.
 *
 * The CLI cases run the real script in a throwaway git repo, because the file
 * set comes from `git ls-files` and the exit code from `process.exit` — neither
 * is observable from the pure functions alone.
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

import { decideExit, mergeRequirements } from './verify-immutable-registry'

const REGISTRY_PATH = 'script/deploy/resources/immutableRegistry.json'
const REQUIREMENTS_PATH = 'script/deploy/resources/deployRequirements.json'
const SCRIPT = 'script/deploy/immutables/verify-immutable-registry.ts'

/** Shape-only stand-in; mergeRequirements copies configData without reading it. */
const CONFIG_DATA = {
  configFileName: 'global.json',
  keyInConfigFile: 'k',
} as unknown as never

describe('mergeRequirements', () => {
  it('keeps a contract that only deployRequirements knows', () => {
    const merged = mergeRequirements({ A: { configData: {} } }, {})
    expect(Object.keys(merged)).toEqual(['A'])
    expect(merged['A']).toEqual({ configData: {} })
  })

  it('keeps a contract that only the registry knows', () => {
    const entry = { FEE: { source: 'config', configData: 'feeKey' } }
    const merged = mergeRequirements({}, { B: entry })
    expect(Object.keys(merged)).toEqual(['B'])
    expect(merged['B']).toEqual({ immutables: entry })
  })

  it('unions both sides for a contract in each, dropping neither', () => {
    const entry = { FEE: { source: 'config', configData: 'feeKey' } }
    const merged = mergeRequirements(
      { C: { configData: { k: CONFIG_DATA } } },
      { C: entry }
    )
    expect(merged['C']).toEqual({
      configData: { k: CONFIG_DATA },
      immutables: entry,
    })
  })

  it('returns every contract from both files exactly once', () => {
    const merged = mergeRequirements(
      { A: { configData: {} }, C: { configData: {} } },
      {
        B: { X: { source: 'config', configData: 'x' } },
        C: { Y: { source: 'config', configData: 'y' } },
      }
    )
    expect(Object.keys(merged).sort()).toEqual(['A', 'B', 'C'])
  })
})

describe('decideExit', () => {
  it('exits 0 when nothing was found', () => {
    expect(
      decideExit({ unreadable: 0, errors: 0, warnings: 0 }, false).code
    ).toBe(0)
  })

  it('exits 1 on a registry error in either mode', () => {
    expect(
      decideExit({ unreadable: 0, errors: 1, warnings: 0 }, false).code
    ).toBe(1)
    expect(
      decideExit({ unreadable: 0, errors: 1, warnings: 0 }, true).code
    ).toBe(1)
  })

  it('exits 1 on an unreadable declaration in either mode', () => {
    expect(
      decideExit({ unreadable: 1, errors: 0, warnings: 0 }, false).code
    ).toBe(1)
    expect(
      decideExit({ unreadable: 1, errors: 0, warnings: 0 }, true).code
    ).toBe(1)
  })

  it('exits 0 on warnings alone without --strict', () => {
    expect(
      decideExit({ unreadable: 0, errors: 0, warnings: 3 }, false).code
    ).toBe(0)
  })

  it('exits 1 on warnings alone with --strict', () => {
    expect(
      decideExit({ unreadable: 0, errors: 0, warnings: 3 }, true).code
    ).toBe(1)
  })

  it('reports the error category, not the authoring gap, when both are present', () => {
    const decision = decideExit({ unreadable: 0, errors: 1, warnings: 5 }, true)
    expect(decision.reason).toMatch(/fail in either mode/u)
  })
})

/** Builds a throwaway repo the CLI can run against, and returns its path. */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'immutable-registry-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  spawnSync('git', ['init', '-q'], { cwd: root })
  spawnSync('git', ['add', '-A'], { cwd: root })
  return root
}

const CLEAN_CONTRACT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

contract Clean {
    address public immutable OWNER;
}
`

const runGate = (root: string, args: string[] = []) =>
  spawnSync('bunx', ['tsx', join(process.cwd(), SCRIPT), ...args], {
    cwd: root,
    encoding: 'utf8',
  })

describe('verify-immutable-registry CLI', () => {
  it('scans exactly the src/*.sol files git tracks', () => {
    const root = makeRepo({
      'src/Clean.sol': CLEAN_CONTRACT,
      // Neither of these is under src/, so neither may be counted.
      'test/Other.sol': CLEAN_CONTRACT,
      'script/Helper.sol': CLEAN_CONTRACT,
      [REGISTRY_PATH]: JSON.stringify({}),
      [REQUIREMENTS_PATH]: JSON.stringify({}),
    })
    const output = (({ stdout, stderr }) => stdout + stderr)(runGate(root))
    // The identical contract sits in all three paths, so the gate naming only
    // the src/ one is what proves the glob did not leak.
    expect(output).toMatch(/src\/Clean\.sol/u)
    expect(output).not.toMatch(/test\/Other\.sol/u)
    expect(output).not.toMatch(/script\/Helper\.sol/u)
    expect(output).toMatch(/1 immutable\(s\) have no registry entry yet/u)
  })

  it('exits 0 when an immutable has no entry and --strict is absent', () => {
    const root = makeRepo({
      'src/Clean.sol': CLEAN_CONTRACT,
      [REGISTRY_PATH]: JSON.stringify({}),
      [REQUIREMENTS_PATH]: JSON.stringify({}),
    })
    expect(runGate(root).status).toBe(0)
  })

  it('exits 1 for the same input with --strict', () => {
    const root = makeRepo({
      'src/Clean.sol': CLEAN_CONTRACT,
      [REGISTRY_PATH]: JSON.stringify({}),
      [REQUIREMENTS_PATH]: JSON.stringify({}),
    })
    expect(runGate(root, ['--strict']).status).toBe(1)
  })

  it('exits 1 on a malformed registry in either mode', () => {
    const root = makeRepo({
      'src/Clean.sol': CLEAN_CONTRACT,
      [REGISTRY_PATH]: JSON.stringify({
        Clean: { OWNER: { source: 'nonsense' } },
      }),
      [REQUIREMENTS_PATH]: JSON.stringify({}),
    })
    expect(runGate(root).status).toBe(1)
  })

  it('exits 1 on a declaration it cannot read, without --strict', () => {
    const root = makeRepo({
      'src/Weird.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

contract Weird {
    address public immutable;
}
`,
      [REGISTRY_PATH]: JSON.stringify({}),
      [REQUIREMENTS_PATH]: JSON.stringify({}),
    })
    expect(runGate(root).status).toBe(1)
  })
})
