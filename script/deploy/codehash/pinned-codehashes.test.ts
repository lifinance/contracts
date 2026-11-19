import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { readFileSync } from 'fs'

import {
  parsePinnedCodehashes,
  PINNED_CODEHASHES_REPO_PATH,
  pinnedKey,
} from './pinned-codehashes'

const ADDRESS = '0x5A4966A80B95D867Ee5804FF84b8b75f260D9282'
const CODEHASH = `0x${'de'.repeat(32)}`

const file = (deployments: Record<string, unknown>, source: unknown = 's') => ({
  Ledger: { source, deployments },
})

const thrown = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a throw')
}

describe('parsePinnedCodehashes', () => {
  it('indexes every deployment by network and lowercase address', () => {
    const pinned = parsePinnedCodehashes(
      file({ mainnet: { address: ADDRESS, codehash: CODEHASH } })
    )

    expect(pinned.get(pinnedKey('MAINNET', ADDRESS.toLowerCase()))).toEqual({
      codehash: CODEHASH,
      label: 'Ledger on mainnet',
    })
    expect(pinned.size).toBe(1)
  })

  it('reads an empty file as nothing pinned', () => {
    expect(parsePinnedCodehashes({}).size).toBe(0)
  })

  it('rejects a contract without deployments', () => {
    expect(thrown(() => parsePinnedCodehashes({ Ledger: 'x' }))).toContain(
      'Ledger must be an object with deployments'
    )
  })

  it('rejects a contract that names no source', () => {
    expect(thrown(() => parsePinnedCodehashes(file({}, ' ')))).toContain(
      'Ledger must name the source'
    )
  })

  it('rejects a deployment that is not an object', () => {
    expect(thrown(() => parsePinnedCodehashes(file({ base: [] })))).toContain(
      'Ledger.deployments.base must be an object'
    )
  })

  it('rejects an address with a broken checksum', () => {
    const broken = ADDRESS.replace('A', 'a')
    expect(
      thrown(() =>
        parsePinnedCodehashes(
          file({ base: { address: broken, codehash: CODEHASH } })
        )
      )
    ).toContain('base.address is not a valid address')
  })

  it('rejects a codehash that is not a lowercase 32-byte hash', () => {
    for (const codehash of [CODEHASH.toUpperCase(), '0xdead', 7])
      expect(
        thrown(() =>
          parsePinnedCodehashes(file({ base: { address: ADDRESS, codehash } }))
        )
      ).toContain('base.codehash is not a lowercase 32-byte hash')
  })

  it('rejects one address pinned twice on a network', () => {
    expect(
      thrown(() =>
        parsePinnedCodehashes({
          ...file({ base: { address: ADDRESS, codehash: CODEHASH } }),
          Other: {
            source: 's',
            deployments: {
              base: { address: ADDRESS.toLowerCase(), codehash: CODEHASH },
            },
          },
        })
      )
    ).toContain('is pinned twice')
  })

  it('accepts the committed file', () => {
    const committed = JSON.parse(
      readFileSync(PINNED_CODEHASHES_REPO_PATH, 'utf8')
    ) as Record<string, unknown>
    expect(parsePinnedCodehashes(committed).size).toBeGreaterThan(0)
  })
})
