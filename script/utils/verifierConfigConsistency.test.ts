/**
 * Keeps `config/networks.json` `verificationType` in agreement with the
 * `foundry.toml` `[etherscan]` entries that need no API key.
 * `verifyContractOnExplorer` routes a network typed `etherscan` through the
 * branch that demands a non-empty key, and passes no `--verifier` for a network
 * without a type, so either way such a network verifies on Sourcify only.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { parse } from 'smol-toml'

const REPO_ROOT = join(import.meta.dir, '..', '..')
// eslint-disable-next-line no-template-curly-in-string -- the literal foundry.toml placeholder
const NO_KEY = '${NO_ETHERSCAN_API_KEY_REQUIRED}'

interface IEtherscanEntry {
  key?: string
  verifier?: string
}

type NetworkTypes = Record<string, { verificationType?: string }>

const findMismatches = (
  etherscan: Record<string, IEtherscanEntry>,
  networks: NetworkTypes
): string[] => {
  const mismatches: string[] = []
  for (const [network, entry] of Object.entries(etherscan)) {
    if (entry.key !== NO_KEY) continue
    const row = networks[network]
    if (row === undefined) continue

    const verificationType = row.verificationType
    const verifier = entry.verifier
    const agrees =
      verificationType !== undefined &&
      verificationType !== 'etherscan' &&
      (verifier === undefined || verificationType === verifier)
    if (!agrees)
      mismatches.push(
        `${network}: foundry.toml verifier "${
          verifier ?? '<none>'
        }", networks.json verificationType "${verificationType}"`
      )
  }
  return mismatches
}

describe('findMismatches', () => {
  it('reports a keyless network typed etherscan with its verifier and type', () => {
    expect(
      findMismatches(
        { xlayer: { key: NO_KEY, verifier: 'oklink' } },
        { xlayer: { verificationType: 'etherscan' } }
      )
    ).toEqual([
      'xlayer: foundry.toml verifier "oklink", networks.json verificationType "etherscan"',
    ])
  })

  it('reports a type that differs from the declared verifier', () => {
    expect(
      findMismatches(
        { lisk: { key: NO_KEY, verifier: 'blockscout' } },
        { lisk: { verificationType: 'sourcify' } }
      )
    ).toEqual([
      'lisk: foundry.toml verifier "blockscout", networks.json verificationType "sourcify"',
    ])
  })

  it('reports an entry without a verifier only when typed etherscan', () => {
    expect(
      findMismatches(
        {
          nibiru: { key: NO_KEY },
          other: { key: NO_KEY },
        },
        {
          nibiru: { verificationType: 'routescan' },
          other: { verificationType: 'etherscan' },
        }
      )
    ).toEqual([
      'other: foundry.toml verifier "<none>", networks.json verificationType "etherscan"',
    ])
  })

  it('reports a keyless network without a verificationType', () => {
    expect(findMismatches({ jovay: { key: NO_KEY } }, { jovay: {} })).toEqual([
      'jovay: foundry.toml verifier "<none>", networks.json verificationType "undefined"',
    ])
  })

  it('skips a network missing from networks.json', () => {
    expect(
      findMismatches(
        { sometestnet: { key: NO_KEY, verifier: 'blockscout' } },
        {}
      )
    ).toEqual([])
  })

  it('ignores entries that use a real API key', () => {
    expect(
      findMismatches(
        {
          base: {
            key: NO_KEY.replace(
              'NO_ETHERSCAN_API_KEY_REQUIRED',
              'BASE_ETHERSCAN_API_KEY'
            ),
          },
        },
        { base: { verificationType: 'etherscan' } }
      )
    ).toEqual([])
  })
})

describe('foundry.toml and config/networks.json', () => {
  it('agree on the verifier of every network that needs no API key', () => {
    const foundry = parse(
      readFileSync(join(REPO_ROOT, 'foundry.toml'), 'utf8')
    ) as { etherscan?: Record<string, IEtherscanEntry> }
    const networks = JSON.parse(
      readFileSync(join(REPO_ROOT, 'config', 'networks.json'), 'utf8')
    ) as NetworkTypes

    expect(foundry.etherscan).toBeDefined()
    expect(findMismatches(foundry.etherscan ?? {}, networks)).toEqual([])
  })
})
