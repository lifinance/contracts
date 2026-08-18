import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { toFunctionSelector } from 'viem'

import {
  buildSelectorMapFromClearSigningFormats,
  buildSelectorMapFromWhitelist,
  getLocalSelectorInfo,
  parseFourByteBatchResponse,
  resolveSelectorsViaFourByte,
} from './selector-registry'

const TRANSFER_SELECTOR = toFunctionSelector('transfer(address,uint256)') // 0xa9059cbb
const SCHEDULE_BATCH_SELECTOR = toFunctionSelector(
  'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)'
) // 0x8f2a0bb0

describe('getLocalSelectorInfo', () => {
  it('resolves TimelockController scheduleBatch without any network call', () => {
    const info = getLocalSelectorInfo(SCHEDULE_BATCH_SELECTOR)
    expect(info?.name).toBe('scheduleBatch')
  })

  it('resolves ERC20 transfer from the well-known signature list', () => {
    const info = getLocalSelectorInfo(TRANSFER_SELECTOR)
    expect(info?.name).toBe('transfer')
    expect(info?.signature).toBe('transfer(address,uint256)')
  })

  it('resolves a diamond function published in clearSigningProposal.json', () => {
    // Key taken from config/clearSigningProposal.json formats
    const selector = toFunctionSelector(
      'function startBridgeTokensViaAcrossV4ERC20Packed()'
    )
    const info = getLocalSelectorInfo(selector)
    expect(info?.name).toBe('startBridgeTokensViaAcrossV4ERC20Packed')
  })

  it('is case-insensitive on the selector', () => {
    const info = getLocalSelectorInfo(TRANSFER_SELECTOR.toUpperCase())
    expect(info?.name).toBe('transfer')
  })

  it('returns undefined for an unknown selector', () => {
    expect(getLocalSelectorInfo('0xdeadbee1')).toBeUndefined()
  })
})

describe('buildSelectorMapFromClearSigningFormats', () => {
  it('derives selectors from human-readable signature keys with named params', () => {
    const map = buildSelectorMapFromClearSigningFormats({
      'transferFoo(address to, uint256 amount)': {},
    })
    const expected = toFunctionSelector('transferFoo(address,uint256)')
    expect(map.get(expected)?.name).toBe('transferFoo')
    expect(map.get(expected)?.signature).toBe('transferFoo(address,uint256)')
  })

  it('handles tuple params with named components', () => {
    const map = buildSelectorMapFromClearSigningFormats({
      'bar((bytes32 id, string label) _data, uint256 _amount)': {},
    })
    const expected = toFunctionSelector('bar((bytes32,string),uint256)')
    expect(map.get(expected)?.name).toBe('bar')
  })

  it('skips unparseable keys without throwing', () => {
    const map = buildSelectorMapFromClearSigningFormats({
      'not a signature at all': {},
      'ok()': {},
    })
    expect(map.get(toFunctionSelector('ok()'))?.name).toBe('ok')
    expect(map.size).toBe(1)
  })
})

describe('buildSelectorMapFromWhitelist', () => {
  const SWAP_COMPLETE_SIG = 'swapAndCompleteBridgeTokens(bytes32)'
  const SWAP_COMPLETE_SELECTOR = toFunctionSelector(SWAP_COMPLETE_SIG)
  const SWAP_EXACT_SIG = 'swapExactTokensForTokens(uint256,uint256)'
  const SWAP_EXACT_SELECTOR = toFunctionSelector(SWAP_EXACT_SIG)

  it('harvests PERIPHERY selector/signature entries', () => {
    const map = buildSelectorMapFromWhitelist({
      PERIPHERY: {
        mainnet: [
          {
            name: 'Executor',
            address: '0x0000000000000000000000000000000000000001',
            selectors: [
              {
                selector: SWAP_COMPLETE_SELECTOR,
                signature: SWAP_COMPLETE_SIG,
              },
            ],
          },
        ],
      },
    })
    expect(map.get(SWAP_COMPLETE_SELECTOR)?.name).toBe(
      'swapAndCompleteBridgeTokens'
    )
    expect(map.get(SWAP_COMPLETE_SELECTOR)?.signature).toBe(SWAP_COMPLETE_SIG)
  })

  it('harvests section contracts functions maps', () => {
    const map = buildSelectorMapFromWhitelist({
      DEX: [
        {
          name: 'SomeDex',
          contracts: {
            mainnet: [
              {
                address: '0x0000000000000000000000000000000000000002',
                functions: {
                  [SWAP_EXACT_SELECTOR]: SWAP_EXACT_SIG,
                },
              },
            ],
          },
        },
      ],
    })
    expect(map.get(SWAP_EXACT_SELECTOR)?.name).toBe('swapExactTokensForTokens')
  })

  it('drops entries whose signature does not hash to the claimed selector', () => {
    const map = buildSelectorMapFromWhitelist({
      PERIPHERY: {
        mainnet: [
          {
            name: 'Executor',
            address: '0x0000000000000000000000000000000000000001',
            selectors: [
              // Wrong selector for the signature — must not surface a
              // wrong-but-plausible function name in the signing UI.
              { selector: '0xdeadbeef', signature: SWAP_COMPLETE_SIG },
              // Unparseable signature — dropped without throwing.
              { selector: '0x12345678', signature: 'not a signature' },
            ],
          },
        ],
      },
    })
    expect(map.size).toBe(0)
  })

  it('returns an empty map for malformed input', () => {
    expect(buildSelectorMapFromWhitelist(null).size).toBe(0)
    expect(buildSelectorMapFromWhitelist('nope').size).toBe(0)
  })
})

describe('parseFourByteBatchResponse', () => {
  const RESPONSE = {
    ok: true,
    result: {
      function: {
        '0xa9059cbb': [
          {
            name: 'transfer(address,uint256)',
            filtered: false,
            hasVerifiedContract: true,
          },
        ],
        '0x8f2a0bb0': [
          {
            name: 'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
            filtered: false,
            hasVerifiedContract: true,
          },
        ],
      },
      event: {},
    },
  }

  it('extracts one signature per requested selector', () => {
    const map = parseFourByteBatchResponse(RESPONSE, [
      '0xa9059cbb',
      '0x8f2a0bb0',
    ])
    expect(map.get('0xa9059cbb')).toBe('transfer(address,uint256)')
    expect(map.get('0x8f2a0bb0')).toBe(
      'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)'
    )
  })

  it('omits selectors with no result', () => {
    const map = parseFourByteBatchResponse(RESPONSE, ['0xdeadbee1'])
    expect(map.has('0xdeadbee1')).toBe(false)
  })

  it('picks the entry that hashes to the selector, skipping colliding wrong ones', () => {
    const response = {
      ok: true,
      result: {
        function: {
          [TRANSFER_SELECTOR]: [
            // 4byte returns collisions; the first does not hash to the selector.
            { name: 'not_transfer(address,uint256)' },
            { name: 'transfer(address,uint256)' },
          ],
        },
        event: {},
      },
    }
    const map = parseFourByteBatchResponse(response, [TRANSFER_SELECTOR])
    expect(map.get(TRANSFER_SELECTOR)).toBe('transfer(address,uint256)')
  })

  it('drops a selector whose only signature does not hash to it', () => {
    const response = {
      ok: true,
      result: {
        function: { [TRANSFER_SELECTOR]: [{ name: 'foo(uint256)' }] },
        event: {},
      },
    }
    const map = parseFourByteBatchResponse(response, [TRANSFER_SELECTOR])
    expect(map.has(TRANSFER_SELECTOR)).toBe(false)
  })

  it('returns an empty map for malformed responses', () => {
    expect(parseFourByteBatchResponse(null, ['0xa9059cbb']).size).toBe(0)
    expect(parseFourByteBatchResponse({ ok: false }, ['0xa9059cbb']).size).toBe(
      0
    )
  })
})

describe('resolveSelectorsViaFourByte', () => {
  function makeTmpCachePath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selector-cache-'))
    return path.join(dir, 'selector-signatures.json')
  }

  function makeFetcher(responses: Record<string, string>) {
    let calls = 0
    const fetcher = async (url: string): Promise<Response> => {
      calls++
      const selectorsParam = new URL(url).searchParams.get('function') ?? ''
      const fn: Record<string, { name: string }[]> = {}
      for (const sel of selectorsParam.split(',')) {
        const sig = responses[sel.toLowerCase()]
        if (sig) fn[sel.toLowerCase()] = [{ name: sig }]
      }
      return new Response(
        JSON.stringify({ ok: true, result: { function: fn, event: {} } })
      )
    }
    return { fetcher, callCount: () => calls }
  }

  const FOO_SELECTOR = toFunctionSelector('foo(uint256)') // 0x2fbebd38

  it('resolves a batch of selectors with a single request', async () => {
    const cachePath = makeTmpCachePath()
    const { fetcher, callCount } = makeFetcher({
      [TRANSFER_SELECTOR]: 'transfer(address,uint256)',
      [FOO_SELECTOR]: 'foo(uint256)',
    })
    const map = await resolveSelectorsViaFourByte(
      [TRANSFER_SELECTOR, FOO_SELECTOR],
      { cachePath, fetcher }
    )
    expect(map.get(TRANSFER_SELECTOR)).toBe('transfer(address,uint256)')
    expect(map.get(FOO_SELECTOR)).toBe('foo(uint256)')
    expect(callCount()).toBe(1)
  })

  it('serves repeat lookups from the disk cache without fetching', async () => {
    const cachePath = makeTmpCachePath()
    const { fetcher, callCount } = makeFetcher({
      '0xa9059cbb': 'transfer(address,uint256)',
    })
    await resolveSelectorsViaFourByte(['0xa9059cbb'], { cachePath, fetcher })
    expect(callCount()).toBe(1)

    // Fresh fetcher proves the second resolution never hits the network
    const second = makeFetcher({})
    const map = await resolveSelectorsViaFourByte(['0xa9059cbb'], {
      cachePath,
      fetcher: second.fetcher,
    })
    expect(map.get('0xa9059cbb')).toBe('transfer(address,uint256)')
    expect(second.callCount()).toBe(0)
  })

  it('ignores a poisoned disk-cache entry that does not hash to its selector', async () => {
    const cachePath = makeTmpCachePath()
    // Hand-edited / poisoned cache: right selector, wrong signature.
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ [TRANSFER_SELECTOR]: 'foo(uint256)' })
    )
    const { fetcher, callCount } = makeFetcher({}) // network offers nothing
    const map = await resolveSelectorsViaFourByte([TRANSFER_SELECTOR], {
      cachePath,
      fetcher,
    })
    // The poisoned entry is not trusted, so resolution falls through to the
    // network (proven by the fetch) rather than returning the wrong signature.
    expect(map.has(TRANSFER_SELECTOR)).toBe(false)
    expect(callCount()).toBe(1)
  })

  it('does not persist negative results to disk', async () => {
    const cachePath = makeTmpCachePath()
    const { fetcher } = makeFetcher({})
    await resolveSelectorsViaFourByte(['0xdeadbee1'], { cachePath, fetcher })
    if (fs.existsSync(cachePath)) {
      const stored = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      expect(stored['0xdeadbee1']).toBeUndefined()
    }
  })

  it('returns network results even when the cache path is unwritable', async () => {
    const { fetcher } = makeFetcher({
      '0xa9059cbb': 'transfer(address,uint256)',
    })
    const map = await resolveSelectorsViaFourByte(['0xa9059cbb'], {
      cachePath: '/nonexistent-dir/deeper/cache.json',
      fetcher,
    })
    expect(map.get('0xa9059cbb')).toBe('transfer(address,uint256)')
  })
})
