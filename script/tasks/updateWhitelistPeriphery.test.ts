import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

/**
 * Per-contract network counts the generator reports for production, parsed out of a
 * real `--dryRun` invocation. Driving the CLI rather than importing it keeps the
 * assertion on the code path `diamondSyncWhitelist.sh` actually runs — the module
 * calls `runMain` at import time, so it cannot be imported without executing.
 */
function productionDistribution(): Record<string, number> {
  const stdout = execFileSync(
    'bunx',
    ['tsx', 'script/tasks/updateWhitelistPeriphery.ts', '--dryRun'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  )
  const lines = stdout.split('\n')
  const start = lines.findIndex((l) =>
    l.includes('Production contract distribution:')
  )
  expect(start).toBeGreaterThan(-1)

  const counts: Record<string, number> = {}
  for (const line of lines.slice(start + 1)) {
    if (line.includes('distribution:') || line.includes('Total staging')) break
    const match = line.match(/([A-Za-z0-9]+):\s+(\d+) networks/)
    if (match?.[1] && match[2]) counts[match[1]] = Number(match[2])
  }
  return counts
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
    const counts = productionDistribution()

    for (const [contract, allowed] of Object.entries(scope)) {
      const deployed = deployedOn(contract)
      const expected = deployed.filter((network) =>
        allowed.some((a) => a.toLowerCase() === network.toLowerCase())
      )

      // Guards the guard: if the scope only ever matched what was deployed anyway,
      // dropping the filter would not change the count and this test would pass
      // against a broken generator.
      expect(
        deployed.length,
        `${contract} is scoped but deployed on no more networks than its scope — this test cannot detect a missing scope filter`
      ).toBeGreaterThan(expected.length)

      expect(counts[contract], `${contract} production network count`).toBe(
        expected.length
      )
    }
  }, 120_000)

  it('leaves unscoped contracts on every network they are deployed to', () => {
    const counts = productionDistribution()
    const eligible = Object.keys(
      globalConfig.whitelistPeripheryFunctions as Record<string, unknown>
    )

    for (const contract of eligible) {
      if (scope[contract]) continue
      expect(
        counts[contract] ?? 0,
        `${contract} production network count`
      ).toBe(deployedOn(contract).length)
    }
  }, 120_000)
})
