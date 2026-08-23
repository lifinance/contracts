import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WHITELIST_PATH = `${REPO_ROOT}/config/whitelist.json`

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

interface IWhitelistEntry {
  name: string
}

/**
 * Regenerates `config/whitelist.json` in place and returns the networks each periphery
 * contract landed on, restoring the committed file afterwards.
 *
 * Asserting on the produced artifact rather than the CLI's log output keeps the test
 * independent of how `consola` routes and formats lines, which differs between a local
 * TTY and CI. The module calls `runMain` at import time, so it cannot be imported
 * without executing — hence the subprocess.
 */
function networksPerContract(): Record<string, string[]> {
  const committed = readFileSync(WHITELIST_PATH, 'utf8')
  try {
    execFileSync('bunx', ['tsx', 'script/tasks/updateWhitelistPeriphery.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    const periphery = readJson(WHITELIST_PATH).PERIPHERY as Record<
      string,
      IWhitelistEntry[]
    >
    const result: Record<string, string[]> = {}
    for (const [network, entries] of Object.entries(periphery ?? {}))
      for (const { name } of entries ?? []) (result[name] ??= []).push(network)
    return result
  } finally {
    writeFileSync(WHITELIST_PATH, committed)
  }
}

describe('updateWhitelistPeriphery network scoping', () => {
  const globalConfig = readJson(`${REPO_ROOT}/config/global.json`)
  const scope = (globalConfig.whitelistPeripheryNetworks ?? {}) as Record<
    string,
    string[]
  >
  const networks = Object.keys(readJson(`${REPO_ROOT}/config/networks.json`))

  const deployedOn = (contract: string): string[] =>
    networks.filter((network) => {
      const path = `${REPO_ROOT}/deployments/${network}.json`
      return existsSync(path) && Boolean(readJson(path)[contract])
    })

  it('emits a scoped contract on exactly its in-scope deployed networks', () => {
    const generated = networksPerContract()

    for (const [contract, allowed] of Object.entries(scope)) {
      const deployed = deployedOn(contract)
      const expected = deployed
        .filter((network) =>
          allowed.some((a) => a.toLowerCase() === network.toLowerCase())
        )
        .sort()

      // Guards the guard: if the scope already matched everything the contract is
      // deployed to, dropping the filter would not change the output and this test
      // would pass against a broken generator.
      expect(
        deployed.length,
        `${contract} is scoped but deployed on no more networks than its scope — this test cannot detect a missing scope filter`
      ).toBeGreaterThan(expected.length)

      expect((generated[contract] ?? []).sort(), contract).toEqual(expected)
    }
  }, 180_000)

  it('leaves unscoped contracts on every network they are deployed to', () => {
    const generated = networksPerContract()
    const eligible = Object.keys(
      globalConfig.whitelistPeripheryFunctions as Record<string, unknown>
    )

    for (const contract of eligible) {
      if (scope[contract]) continue
      expect((generated[contract] ?? []).sort(), contract).toEqual(
        deployedOn(contract).sort()
      )
    }
  }, 180_000)
})
