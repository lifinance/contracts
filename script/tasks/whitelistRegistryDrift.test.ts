/**
 * Tests for the registry/config invariant the whitelist sync applies before it
 * writes any diamond-called periphery pair.
 */
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  type Address,
} from 'viem'

import type { IPeripheryRouteConfig } from './proposePeripheryWithWhitelist'
import { EXIT_REFUSED } from './proposePeripheryWithWhitelist'
import {
  RegistryReadRefusal,
  describeDrift,
  driftPairKeys,
  findRegistryDrift,
  tronRegistryReader,
  withTronRateLimit,
} from './whitelistRegistryDrift'

const OLD_WRAPPER = getAddress('0x5215E9fd223BC909083fbdB2860213873046e45d')
const NEW_WRAPPER = getAddress('0x254bA6498aDDA926C75d49E9909f308bFaf4720E')
const GASZIP = getAddress('0x1e5637e6bE93D50bB8eFa70D219d06291dcF5284')
const DIAMOND = getAddress('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE')
const DEX = getAddress('0xDef1C0ded9bec7F1a1670819833240f027b25EfF')

const routeConfig: IPeripheryRouteConfig = {
  whitelistPeripheryFunctions: {
    TokenWrapper: [
      { selector: '0xD0E30DB0', signature: 'deposit()' },
      { selector: '0x3ccfd60b', signature: 'withdraw()' },
    ],
    GasZipPeriphery: [{ selector: '0x8b71ae6c', signature: 'a()' }],
    LiFiDEXAggregator: [{ selector: '0x2646478b', signature: 'x()' }],
  },
  whitelistPeripheryNetworks: { LiFiDEXAggregator: ['lens'] },
}

const reader = (registered: Record<string, string | undefined>) => {
  const reads: string[] = []
  return {
    reads,
    readRegistered: async (name: string) => {
      reads.push(name)
      if (registered[name] === 'THROW') throw new Error('rpc down')
      return registered[name]
    },
  }
}

describe('findRegistryDrift', () => {
  it('reports a name whose registry still points at the replaced address', async () => {
    const { readRegistered } = reader({
      TokenWrapper: OLD_WRAPPER,
      GasZipPeriphery: GASZIP,
    })
    const drift = await findRegistryDrift({
      network: 'fuse',
      entries: [
        { name: 'TokenWrapper', address: NEW_WRAPPER },
        { name: 'GasZipPeriphery', address: GASZIP },
      ],
      routeConfig,
      readRegistered,
    })
    expect(drift).toEqual([
      {
        name: 'TokenWrapper',
        registry: OLD_WRAPPER,
        config: NEW_WRAPPER,
        selectors: ['0xd0e30db0', '0x3ccfd60b'],
      },
    ])
    expect([...driftPairKeys(drift)].sort()).toEqual(
      [
        `${OLD_WRAPPER.toLowerCase()}|0xd0e30db0`,
        `${OLD_WRAPPER.toLowerCase()}|0x3ccfd60b`,
        `${NEW_WRAPPER.toLowerCase()}|0xd0e30db0`,
        `${NEW_WRAPPER.toLowerCase()}|0x3ccfd60b`,
      ].sort()
    )
  })

  it('reports the reverse case: registry moved on, config still lists the old address', async () => {
    const { readRegistered } = reader({ TokenWrapper: NEW_WRAPPER })
    const drift = await findRegistryDrift({
      network: 'fuse',
      entries: [{ name: 'TokenWrapper', address: OLD_WRAPPER }],
      routeConfig,
      readRegistered,
    })
    expect(drift.map((d) => [d.registry, d.config])).toEqual([
      [NEW_WRAPPER, OLD_WRAPPER],
    ])
    expect(driftPairKeys(drift).size).toBe(4)
  })

  it('reports nothing when registry and config agree, in any letter case', async () => {
    const { readRegistered, reads } = reader({
      TokenWrapper: NEW_WRAPPER.toLowerCase(),
      GasZipPeriphery: GASZIP,
    })
    const drift = await findRegistryDrift({
      network: 'fuse',
      entries: [
        { name: 'TokenWrapper', address: NEW_WRAPPER },
        { name: 'GasZipPeriphery', address: GASZIP },
        { name: 'Composer', address: DEX },
      ],
      routeConfig,
      readRegistered,
    })
    expect(drift).toEqual([])
    expect(driftPairKeys(drift).size).toBe(0)
    // every in-scope diamond-called name is read, Composer is not one
    expect(reads.sort()).toEqual(['GasZipPeriphery', 'TokenWrapper'])
  })

  it('treats a registered name the config does not list as drift, and the reverse', async () => {
    const { readRegistered } = reader({ TokenWrapper: OLD_WRAPPER })
    const drift = await findRegistryDrift({
      network: 'fuse',
      entries: [{ name: 'GasZipPeriphery', address: GASZIP }],
      routeConfig,
      readRegistered,
    })
    expect(
      drift.map((d) => [d.name, d.registry ?? null, d.config ?? null])
    ).toEqual([
      ['TokenWrapper', OLD_WRAPPER, null],
      ['GasZipPeriphery', null, GASZIP],
    ])
  })

  it('does not read a name out of network scope', async () => {
    const { readRegistered, reads } = reader({})
    await findRegistryDrift({
      network: 'fuse',
      entries: [],
      routeConfig,
      readRegistered,
    })
    expect(reads).not.toContain('LiFiDEXAggregator')
    const lens = reader({})
    await findRegistryDrift({
      network: 'lens',
      entries: [],
      routeConfig,
      readRegistered: lens.readRegistered,
    })
    expect(lens.reads).toContain('LiFiDEXAggregator')
  })

  it('refuses when a registry read fails, instead of reporting agreement', async () => {
    const { readRegistered } = reader({
      TokenWrapper: NEW_WRAPPER,
      GasZipPeriphery: 'THROW',
    })
    const run = findRegistryDrift({
      network: 'fuse',
      entries: [{ name: 'TokenWrapper', address: NEW_WRAPPER }],
      routeConfig,
      readRegistered,
    })
    const error: unknown = await run.then(
      () => undefined,
      (rejected: unknown) => rejected
    )
    expect(error).toBeInstanceOf(RegistryReadRefusal)
    expect((error as Error).message).toContain('GasZipPeriphery')
  })

  it('compares Tron base58 addresses exactly', async () => {
    const tronA = 'TBfUqkmaBBMFA87ZCCu9aibjo2EZLTSJv2'
    const { readRegistered } = reader({ TokenWrapper: tronA })
    const same = await findRegistryDrift({
      network: 'tron',
      entries: [{ name: 'TokenWrapper', address: tronA }],
      routeConfig,
      readRegistered,
    })
    expect(same).toEqual([])
  })

  it('treats base58 addresses differing only in case as different on Tron', async () => {
    const tronA = 'TBfUqkmaBBMFA87ZCCu9aibjo2EZLTSJv2'
    const { readRegistered } = reader({ TokenWrapper: tronA })
    const drift = await findRegistryDrift({
      network: 'tron',
      entries: [{ name: 'TokenWrapper', address: tronA.toLowerCase() }],
      routeConfig,
      readRegistered,
    })
    expect(drift.map((d) => d.name)).toEqual(['TokenWrapper'])
  })
})

describe('withTronRateLimit', () => {
  it('retries a 429 read instead of failing the network', async () => {
    let calls = 0
    const read = withTronRateLimit(async (name: string) => {
      calls++
      if (calls === 1) throw new Error('429 Too Many Requests')
      return name
    }, 0)
    expect(await read('TokenWrapper')).toBe('TokenWrapper')
    expect(calls).toBe(2)
  })

  it('does not retry an error that is not a rate limit', async () => {
    let calls = 0
    const read = withTronRateLimit(async (_name: string): Promise<string> => {
      calls++
      throw new Error('bad ABI')
    }, 0)
    const message = await read('TokenWrapper').then(
      () => undefined,
      (e: Error) => e.message
    )
    expect(message).toBe('bad ABI')
    expect(calls).toBe(1)
  })
})

describe('tronRegistryReader', () => {
  const ZERO = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
  const toBase58 = (hex: string) => hex

  it('retries a 429 then resolves', async () => {
    let calls = 0
    const read = tronRegistryReader(
      async () => {
        calls++
        if (calls === 1) throw new Error('429 Too Many Requests')
        return 'TBfUqkmaBBMFA87ZCCu9aibjo2EZLTSJv2'
      },
      toBase58,
      ZERO,
      0
    )
    expect(await read('TokenWrapper')).toBe(
      'TBfUqkmaBBMFA87ZCCu9aibjo2EZLTSJv2'
    )
    expect(calls).toBe(2)
  })

  it('refuses after three consecutive 429s', async () => {
    let calls = 0
    const read = tronRegistryReader(
      async () => {
        calls++
        throw new Error('429 Too Many Requests')
      },
      toBase58,
      ZERO,
      0
    )
    const message = await read('TokenWrapper').then(
      () => undefined,
      (e: Error) => e.message
    )
    expect(message).toContain('429')
    expect(calls).toBe(3)
  })

  it('maps the zero address to unregistered', async () => {
    const read = tronRegistryReader(async () => ZERO, toBase58, ZERO, 0)
    expect(await read('TokenWrapper')).toBeUndefined()
  })
})

describe('describeDrift', () => {
  it('names both addresses and who owns the change', () => {
    expect(
      describeDrift({
        name: 'TokenWrapper',
        registry: OLD_WRAPPER,
        config: NEW_WRAPPER,
        selectors: [],
      })
    ).toBe(
      `TokenWrapper: registry points at ${OLD_WRAPPER}, config at ${NEW_WRAPPER} — left to the paired registration batch`
    )
    expect(
      describeDrift({
        name: 'TokenWrapper',
        config: NEW_WRAPPER,
        selectors: [],
      })
    ).toContain('registry points at none')
  })
})

describe('whitelistRegistryDrift.ts', () => {
  const REPO_ROOT = join(import.meta.dir, '..', '..')
  const SCRIPT = join(REPO_ROOT, 'script', 'tasks', 'whitelistRegistryDrift.ts')
  const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
  const TIMEOUT_MS = 60_000
  const RPC_ABI = parseAbi([
    'function getPeripheryContract(string) view returns (address)',
  ])
  const ZERO = '0x0000000000000000000000000000000000000000'

  let registered: Record<string, Address> = {}
  let unreadable = false
  let server: Server
  let rpcUrl: string
  let sandbox: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const parsed = JSON.parse(body) as
          | { id: number; method: string; params: unknown[] }
          | { id: number; method: string; params: unknown[] }[]
        const one = (r: { id: number; method: string; params: unknown[] }) => {
          if (r.method === 'eth_chainId')
            return { jsonrpc: '2.0', id: r.id, result: '0x7a' }
          if (r.method !== 'eth_call' || unreadable)
            return {
              jsonrpc: '2.0',
              id: r.id,
              error: { code: -32000, message: 'stub: unreadable' },
            }
          const call = decodeFunctionData({
            abi: RPC_ABI,
            data: (r.params[0] as { data: `0x${string}` }).data,
          })
          return {
            jsonrpc: '2.0',
            id: r.id,
            result: encodeFunctionResult({
              abi: RPC_ABI,
              functionName: 'getPeripheryContract',
              result: registered[call.args[0]] ?? ZERO,
            }),
          }
        }
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed))
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    sandbox = mkdtempSync(join(tmpdir(), 'registry-drift-cli-'))
  })

  afterAll(() => {
    server.close()
    rmSync(sandbox, { recursive: true, force: true })
  })

  const run = async (entries: { name: string; address: string }[]) => {
    const whitelist = join(sandbox, 'whitelist.json')
    writeFileSync(
      whitelist,
      JSON.stringify({ DEXS: [], PERIPHERY: { fuse: entries } })
    )
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: sandbox,
      ETH_NODE_URI_FUSE: rpcUrl,
    }
    const child = spawn(
      TSX,
      [
        SCRIPT,
        '--network',
        'fuse',
        '--diamond',
        DIAMOND,
        '--whitelist',
        whitelist,
      ],
      { cwd: sandbox, env }
    )
    let stdout = ''
    let out = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      out += chunk
    })
    child.stderr.on('data', (chunk) => (out += chunk))
    const rc = await new Promise<number>((resolve) =>
      child.on('close', (code) => resolve(code ?? -1))
    )
    const excluded = stdout
      .split('\n')
      .filter((line) => line.startsWith('EXCLUDE '))
      .map((line) => line.slice('EXCLUDE '.length))
    return { rc, out, excluded }
  }

  it(
    'prints the pairs to leave out when the registry disagrees',
    async () => {
      unreadable = false
      registered = { TokenWrapper: OLD_WRAPPER }
      const { rc, out, excluded } = await run([
        { name: 'TokenWrapper', address: NEW_WRAPPER },
      ])
      expect(rc).toBe(0)
      expect(excluded.sort()).toEqual(
        [
          `${OLD_WRAPPER.toLowerCase()}|0x3ccfd60b`,
          `${OLD_WRAPPER.toLowerCase()}|0xd0e30db0`,
          `${NEW_WRAPPER.toLowerCase()}|0x3ccfd60b`,
          `${NEW_WRAPPER.toLowerCase()}|0xd0e30db0`,
        ].sort()
      )
      expect(out).toContain(
        `TokenWrapper: registry points at ${OLD_WRAPPER}, config at ${NEW_WRAPPER}`
      )
    },
    TIMEOUT_MS
  )

  it(
    'prints nothing to leave out when they agree',
    async () => {
      unreadable = false
      registered = { TokenWrapper: NEW_WRAPPER }
      const { rc, excluded } = await run([
        { name: 'TokenWrapper', address: NEW_WRAPPER },
      ])
      expect(rc).toBe(0)
      expect(excluded).toEqual([])
    },
    TIMEOUT_MS
  )

  it(
    'exits with a refusal when the registry cannot be read',
    async () => {
      unreadable = true
      const { rc, out, excluded } = await run([
        { name: 'TokenWrapper', address: NEW_WRAPPER },
      ])
      expect(rc).toBe(EXIT_REFUSED)
      expect(out).toContain('could not read getPeripheryContract')
      expect(excluded).toEqual([])
    },
    TIMEOUT_MS
  )
})
