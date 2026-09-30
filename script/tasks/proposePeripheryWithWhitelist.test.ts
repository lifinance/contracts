/**
 * Tests for the scoped paired registration batch: one registration, the
 * removal of the replaced address's configured selectors, and the addition of
 * the new address's — and nothing from any other contract.
 */
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
  type Hex,
} from 'viem'

import globalConfig from '../../config/global.json'

import {
  EXIT_REFUSED,
  PREFLIGHT_EXIT_NOT_PAIRED,
  PairedRegistrationRefusal,
  buildScopedPairedBatch,
  chunkPairs,
  isContractBytecode,
  normaliseSelector,
  peripheryRegistrationRoute,
  planRegistrations,
  readRegistrationState,
  requiredSelectorsFor,
  type IPairedRegistrationReader,
  type IPeripheryRouteConfig,
  type IRegistrationChainState,
} from './proposePeripheryWithWhitelist'

const DIAMOND = getAddress('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE')
const OLD_WRAPPER = getAddress('0x5215E9fd223BC909083fbdB2860213873046e45d')
const NEW_WRAPPER = getAddress('0x254bA6498aDDA926C75d49E9909f308bFaf4720E')
const OLD_GASZIP = getAddress('0xFafE4c4CEc5Ed070A4aFDc0f92826c5Ba276Cb80')
const NEW_GASZIP = getAddress('0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2')
const FEE_COLLECTOR = getAddress('0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4')
const WRAP_DEPOSIT = '0xd0e30db0' as Hex
const WRAP_WITHDRAW = '0x3ccfd60b' as Hex
const GASZIP_A = '0x8b71ae6c' as Hex
const GASZIP_B = '0xc4af5a74' as Hex
const UNRELATED = '0x12aa3caf' as Hex

const routeConfig: IPeripheryRouteConfig = {
  whitelistPeripheryFunctions: {
    TokenWrapper: [
      { selector: WRAP_DEPOSIT, signature: 'deposit()' },
      { selector: WRAP_WITHDRAW, signature: 'withdraw()' },
    ],
    GasZipPeriphery: [
      { selector: GASZIP_A, signature: 'a()' },
      { selector: GASZIP_B, signature: 'b()' },
    ],
    LiFiDEXAggregator: [{ selector: '0x2646478b', signature: 'x()' }],
  },
  whitelistPeripheryNetworks: { LiFiDEXAggregator: ['lens'] },
}

const DECODE_ABI = parseAbi([
  'function registerPeripheryContract(string,address)',
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])

const decodeAll = (calldatas: readonly Hex[]) =>
  calldatas.map((data) => decodeFunctionData({ abi: DECODE_ABI, data }))

const wrapperSelectors = [WRAP_DEPOSIT, WRAP_WITHDRAW]

const state = (
  overrides: Partial<IRegistrationChainState> = {}
): IRegistrationChainState => ({
  current: undefined,
  currentSelectors: [],
  currentAlsoRegisteredAs: [],
  hasCode: true,
  ...overrides,
})

const build = (overrides: Partial<IRegistrationChainState> = {}) =>
  buildScopedPairedBatch({
    network: 'fuse',
    diamond: DIAMOND,
    registration: { name: 'TokenWrapper', address: NEW_WRAPPER },
    configured: wrapperSelectors,
    state: state(overrides),
  })

/** A reader over fixed chain state that records every read. */
const fixedReader = (chain: {
  registered?: Record<string, Address>
  selectors?: Record<string, Hex[]>
  codeless?: Address[]
  failOn?: string
}) => {
  const reads: string[] = []
  const reader: IPairedRegistrationReader = {
    getPeripheryContract: async (name) => {
      reads.push(`registry:${name}`)
      if (chain.failOn === `registry:${name}`) throw new Error('rpc down')
      return chain.registered?.[name]
    },
    getWhitelistedSelectors: async (contract) => {
      reads.push(`allowlist:${contract}`)
      if (chain.failOn === `allowlist:${contract}`) throw new Error('rpc down')
      return chain.selectors?.[contract] ?? []
    },
    hasCode: async (address) => {
      reads.push(`code:${address}`)
      if (chain.failOn === `code:${address}`) throw new Error('rpc down')
      return !(chain.codeless ?? []).includes(address)
    },
  }
  return { reader, reads }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected a rejection')
}

describe('peripheryRegistrationRoute', () => {
  it('pairs a diamond-called contract on an unscoped network', () => {
    expect(
      peripheryRegistrationRoute('TokenWrapper', 'fuse', routeConfig)
    ).toBe('paired')
  })

  it('leaves a name outside whitelistPeripheryFunctions on the plain route', () => {
    expect(
      peripheryRegistrationRoute('FeeCollector', 'fuse', routeConfig)
    ).toBe('not-diamond-called')
  })

  it('leaves an out-of-scope LiFiDEXAggregator on the plain route', () => {
    expect(
      peripheryRegistrationRoute('LiFiDEXAggregator', 'fuse', routeConfig)
    ).toBe('out-of-scope')
    // the in-scope control, so the out-of-scope answer is not the only one it gives
    expect(
      peripheryRegistrationRoute('LiFiDEXAggregator', 'LENS', routeConfig)
    ).toBe('paired')
  })

  it('does not read a prototype member as a configured contract', () => {
    expect(peripheryRegistrationRoute('constructor', 'fuse', routeConfig)).toBe(
      'not-diamond-called'
    )
    expect(peripheryRegistrationRoute('toString', 'fuse', routeConfig)).toBe(
      'not-diamond-called'
    )
  })

  it('refuses a scope map naming a contract with no functions', () => {
    expect(() =>
      peripheryRegistrationRoute('TokenWrapper', 'fuse', {
        ...routeConfig,
        whitelistPeripheryNetworks: { TokenWraper: ['fuse'] },
      })
    ).toThrow(/absent from whitelistPeripheryFunctions/)
  })

  it('answers from the committed config/global.json', () => {
    const real = globalConfig as unknown as IPeripheryRouteConfig
    expect(peripheryRegistrationRoute('TokenWrapper', 'fuse', real)).toBe(
      'paired'
    )
    expect(peripheryRegistrationRoute('FeeCollector', 'fuse', real)).toBe(
      'not-diamond-called'
    )
    expect(peripheryRegistrationRoute('LiFiDEXAggregator', 'fuse', real)).toBe(
      'out-of-scope'
    )
    expect(peripheryRegistrationRoute('LiFiDEXAggregator', 'lens', real)).toBe(
      'paired'
    )
  })
})

describe('requiredSelectorsFor', () => {
  it('lowercases and de-duplicates the configured selectors', () => {
    expect(
      requiredSelectorsFor('Patcher', {
        whitelistPeripheryFunctions: {
          Patcher: [
            { selector: '0xEFAE576B', signature: 'x()' },
            { selector: '0xefae576b', signature: 'x()' },
          ],
        },
      })
    ).toEqual(['0xefae576b'])
  })

  it('refuses a diamond-called name that lists no selector', () => {
    expect(() =>
      requiredSelectorsFor('Patcher', {
        whitelistPeripheryFunctions: { Patcher: [] },
      })
    ).toThrow(/lists no selector/)
  })
})

describe('normaliseSelector', () => {
  it('reads every form TronWeb and viem return as 0x-prefixed lowercase', () => {
    expect(normaliseSelector('0x3CCFD60B')).toBe(WRAP_WITHDRAW)
    expect(normaliseSelector('3ccfd60b')).toBe(WRAP_WITHDRAW)
    expect(normaliseSelector('3CCFD60B')).toBe(WRAP_WITHDRAW)
    expect(normaliseSelector(Uint8Array.from([0x3c, 0xcf, 0xd6, 0x0b]))).toBe(
      WRAP_WITHDRAW
    )
    expect(normaliseSelector([0x3c, 0xcf, 0xd6, 0x0b])).toBe(WRAP_WITHDRAW)
  })

  it('refuses anything that is not four bytes', () => {
    for (const bad of [
      '0x3ccfd6',
      '0x3ccfd60b00',
      'zzzzzzzz',
      1,
      undefined,
      [300, 1, 2, 3],
    ])
      expect(() => normaliseSelector(bad)).toThrow(/not a four-byte selector/)
  })
})

describe('buildScopedPairedBatch', () => {
  it('registers a first deployment and whitelists its configured selectors', () => {
    const batch = build()
    expect(batch.targets).toEqual([DIAMOND, DIAMOND])
    const [register, add] = decodeAll(batch.calldatas)
    expect(register?.functionName).toBe('registerPeripheryContract')
    expect(register?.args).toEqual(['TokenWrapper', NEW_WRAPPER])
    expect(add?.args).toEqual([
      [NEW_WRAPPER, NEW_WRAPPER],
      wrapperSelectors,
      true,
    ])
    expect(batch.toRemove).toEqual([])
    expect(batch.replaced).toBeUndefined()
  })

  it('de-whitelists only the configured selectors the replaced address holds', () => {
    const batch = build({
      current: OLD_WRAPPER,
      // one configured selector held, one unrelated selector that must stay
      currentSelectors: [WRAP_WITHDRAW, UNRELATED],
    })
    const [register, remove, add] = decodeAll(batch.calldatas)
    expect(register?.args).toEqual(['TokenWrapper', NEW_WRAPPER])
    expect(remove?.args).toEqual([[OLD_WRAPPER], [WRAP_WITHDRAW], false])
    expect(add?.args?.[0]).toEqual([NEW_WRAPPER, NEW_WRAPPER])
    expect(add?.args?.[2]).toBe(true)
    expect(batch.calldatas).toHaveLength(3)
    expect(batch.replaced).toBe(OLD_WRAPPER)
  })

  it('removes nothing when the name is already registered at the new address', () => {
    const batch = build({
      current: NEW_WRAPPER,
      currentSelectors: wrapperSelectors,
    })
    expect(batch.toRemove).toEqual([])
    expect(decodeAll(batch.calldatas).map((c) => c.functionName)).toEqual([
      'registerPeripheryContract',
      'batchSetContractSelectorWhitelist',
    ])
  })

  it('keeps the replaced address whitelisted while another name still points at it', () => {
    const batch = build({
      current: OLD_WRAPPER,
      currentSelectors: wrapperSelectors,
      currentAlsoRegisteredAs: ['LidoWrapper'],
    })
    expect(batch.toRemove).toEqual([])
    expect(batch.replacedKept).toContain('LidoWrapper')
    expect(batch.calldatas).toHaveLength(2)
  })

  it('keeps the selectors a same-run name at the replaced address is configured with', () => {
    const batch = build({
      current: OLD_WRAPPER,
      currentSelectors: [...wrapperSelectors, GASZIP_A],
      currentAlsoRegisteredAs: [],
      keptForSameRun: [WRAP_WITHDRAW],
    })
    expect(batch.toRemove).toEqual([
      { contract: OLD_WRAPPER, selector: WRAP_DEPOSIT },
    ])
    expect(batch.replacedKept).toBeUndefined()
  })

  it('refuses a codeless address', () => {
    expect(() => build({ hasCode: false })).toThrow(PairedRegistrationRefusal)
    expect(() => build({ hasCode: false })).toThrow(/has no code/)
  })

  it('refuses a batch above the combined-proposal cap', () => {
    const many = Array.from(
      { length: 301 },
      (_, i) => `0x${(i + 1).toString(16).padStart(8, '0')}` as Hex
    )
    expect(() =>
      buildScopedPairedBatch({
        network: 'fuse',
        diamond: DIAMOND,
        registration: { name: 'TokenWrapper', address: NEW_WRAPPER },
        configured: many,
        state: state(),
      })
    ).toThrow(/exceeds the combined-proposal cap/)
  })
})

describe('readRegistrationState', () => {
  const read = (
    chain: Parameters<typeof fixedReader>[0],
    sameRun: string[] = []
  ) => {
    const { reader, reads } = fixedReader(chain)
    return {
      reads,
      state: readRegistrationState({
        registration: { name: 'TokenWrapper', address: NEW_WRAPPER },
        configured: wrapperSelectors,
        diamondCalledNames: Object.keys(
          routeConfig.whitelistPeripheryFunctions ?? {}
        ),
        sameRun,
        routeConfig,
        reader,
      }),
    }
  }

  it('does not count a name this run also replaces as keeping the old address', async () => {
    const { state: result } = read(
      {
        registered: { TokenWrapper: OLD_WRAPPER, GasZipPeriphery: OLD_WRAPPER },
        selectors: { [OLD_WRAPPER]: [...wrapperSelectors, GASZIP_A, GASZIP_B] },
      },
      ['GasZipPeriphery']
    )
    const got = await result
    expect(got.currentAlsoRegisteredAs).toEqual([])
    expect(got.keptForSameRun).toEqual([GASZIP_A, GASZIP_B])
  })

  it('finds the replaced address registered under another diamond-called name', async () => {
    const { state: result } = read({
      registered: { TokenWrapper: OLD_WRAPPER, GasZipPeriphery: OLD_WRAPPER },
      selectors: { [OLD_WRAPPER]: wrapperSelectors },
    })
    expect((await result).currentAlsoRegisteredAs).toEqual(['GasZipPeriphery'])
  })

  it('does not read other names when the replaced address holds no configured selector', async () => {
    const { state: result, reads } = read({
      registered: { TokenWrapper: OLD_WRAPPER },
      selectors: { [OLD_WRAPPER]: [UNRELATED] },
    })
    expect((await result).currentAlsoRegisteredAs).toEqual([])
    expect(reads.filter((r) => r.startsWith('registry:'))).toEqual([
      'registry:TokenWrapper',
    ])
  })
})

describe('planRegistrations', () => {
  const plan = (
    registrations: { name: string; address: Address }[],
    chain: Parameters<typeof fixedReader>[0],
    pair = true
  ) => {
    const { reader, reads } = fixedReader(chain)
    return {
      reads,
      result: planRegistrations({
        network: 'fuse',
        diamond: DIAMOND,
        registrations,
        routeConfig,
        pair,
        reader,
      }),
    }
  }

  it('gives each registration on a network a batch holding only its own pairs', async () => {
    const { result } = plan(
      [
        { name: 'TokenWrapper', address: NEW_WRAPPER },
        { name: 'GasZipPeriphery', address: NEW_GASZIP },
      ],
      {
        registered: { TokenWrapper: OLD_WRAPPER, GasZipPeriphery: OLD_GASZIP },
        selectors: {
          [OLD_WRAPPER]: wrapperSelectors,
          [OLD_GASZIP]: [GASZIP_A, GASZIP_B],
        },
      }
    )
    const { paired, plain } = await result
    expect(plain).toEqual([])
    expect(paired).toHaveLength(2)
    const [wrapper, gasZip] = paired
    const touched = (batch: typeof wrapper) =>
      new Set(
        [...(batch?.toAdd ?? []), ...(batch?.toRemove ?? [])].map(
          (p) => p.contract
        )
      )
    expect(touched(wrapper)).toEqual(new Set([NEW_WRAPPER, OLD_WRAPPER]))
    expect(touched(gasZip)).toEqual(new Set([NEW_GASZIP, OLD_GASZIP]))
    expect(decodeAll(wrapper?.calldatas ?? [])[0]?.args).toEqual([
      'TokenWrapper',
      NEW_WRAPPER,
    ])
    expect(decodeAll(gasZip?.calldatas ?? [])[0]?.args).toEqual([
      'GasZipPeriphery',
      NEW_GASZIP,
    ])
    expect(
      decodeAll(gasZip?.calldatas ?? []).map((c) => c.args[0])
    ).not.toContain('TokenWrapper')
  })

  it('removes a shared old address from both names replaced in the same run', async () => {
    const { result } = plan(
      [
        { name: 'TokenWrapper', address: NEW_WRAPPER },
        { name: 'GasZipPeriphery', address: NEW_GASZIP },
      ],
      {
        registered: { TokenWrapper: OLD_WRAPPER, GasZipPeriphery: OLD_WRAPPER },
        selectors: { [OLD_WRAPPER]: [...wrapperSelectors, GASZIP_A, GASZIP_B] },
      }
    )
    const [wrapper, gasZip] = (await result).paired
    expect(wrapper?.replacedKept).toBeUndefined()
    expect(gasZip?.replacedKept).toBeUndefined()
    expect(wrapper?.toRemove).toEqual(
      wrapperSelectors.map((selector) => ({ contract: OLD_WRAPPER, selector }))
    )
    expect(gasZip?.toRemove).toEqual(
      [GASZIP_A, GASZIP_B].map((selector) => ({
        contract: OLD_WRAPPER,
        selector,
      }))
    )
  })

  it('still keeps a shared old address for a name this run does not replace', async () => {
    const { result } = plan([{ name: 'TokenWrapper', address: NEW_WRAPPER }], {
      registered: { TokenWrapper: OLD_WRAPPER, GasZipPeriphery: OLD_WRAPPER },
      selectors: { [OLD_WRAPPER]: [...wrapperSelectors, GASZIP_A] },
    })
    const [wrapper] = (await result).paired
    expect(wrapper?.toRemove).toEqual([])
    expect(wrapper?.replacedKept).toContain('GasZipPeriphery')
  })

  it('leaves a non-diamond-called registration plain and reads no allowlist for it', async () => {
    const { result, reads } = plan(
      [{ name: 'FeeCollector', address: FEE_COLLECTOR }],
      {}
    )
    expect(await result).toEqual({
      paired: [],
      plain: [{ name: 'FeeCollector', address: FEE_COLLECTOR }],
    })
    expect(reads).toEqual([`code:${FEE_COLLECTOR}`])
  })

  it('pairs nothing when pairing is off', async () => {
    const { result } = plan(
      [{ name: 'TokenWrapper', address: NEW_WRAPPER }],
      {},
      false
    )
    expect((await result).paired).toEqual([])
  })

  it('collects every refusal, plain ones included, before returning', async () => {
    const error = await rejection(
      plan(
        [
          { name: 'FeeCollector', address: FEE_COLLECTOR },
          { name: 'TokenWrapper', address: NEW_WRAPPER },
          { name: 'GasZipPeriphery', address: NEW_GASZIP },
        ],
        {
          registered: { GasZipPeriphery: OLD_GASZIP },
          codeless: [FEE_COLLECTOR],
          failOn: `allowlist:${OLD_GASZIP}`,
        }
      ).result
    )
    expect(error).toBeInstanceOf(PairedRegistrationRefusal)
    expect(error.message).toContain('cannot propose')
    expect(error.message).not.toContain('nothing was proposed')
    expect(error.message).toContain(`FeeCollector ${FEE_COLLECTOR} has no code`)
    expect(error.message).toContain(
      `could not read the chain state of GasZipPeriphery`
    )
    // the one registration that could be built is not the reason it refused
    expect(error.message).not.toContain('TokenWrapper')
  })

  it('refuses when the code of a plain registration cannot be read', async () => {
    const error = await rejection(
      plan([{ name: 'FeeCollector', address: FEE_COLLECTOR }], {
        failOn: `code:${FEE_COLLECTOR}`,
      }).result
    )
    expect(error.message).toContain('could not read the code of FeeCollector')
  })
})

describe('isContractBytecode', () => {
  it('draws the line where LibAsset.isContract does', () => {
    expect(isContractBytecode(`0x${'60'.repeat(24)}`)).toBe(true)
    expect(isContractBytecode('60'.repeat(24))).toBe(true)
    expect(isContractBytecode(`0xef0100${'ab'.repeat(20)}`)).toBe(false)
    expect(isContractBytecode('0x6080')).toBe(false)
    expect(isContractBytecode('0x')).toBe(false)
    expect(isContractBytecode(undefined)).toBe(false)
  })
})

describe('chunkPairs', () => {
  const pairs = Array.from({ length: 301 }, (_, i) => ({
    contract: DIAMOND,
    selector: `0x${i.toString(16).padStart(8, '0')}` as Hex,
  }))

  it('never emits a call above the per-call ceiling', () => {
    const chunks = chunkPairs(pairs)
    expect(chunks.map((c) => c.length)).toEqual([150, 150, 1])
  })

  it('emits nothing for an empty set', () => {
    expect(chunkPairs([])).toEqual([])
  })
})

/**
 * The real CLI, against a local JSON-RPC stub and with `bunx` shimmed, so the
 * propose step it spawns records its arguments and can do nothing else. The
 * working directory holds no `.env`, the environment is built from nothing,
 * and the store URI cannot be parsed, so a child that got past the shim still
 * could not reach a real proposal store.
 */
describe('proposePeripheryWithWhitelist.ts', () => {
  const REPO_ROOT = join(import.meta.dir, '..', '..')
  const SCRIPT = join(
    REPO_ROOT,
    'script',
    'tasks',
    'proposePeripheryWithWhitelist.ts'
  )
  const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
  const TIMEOUT_MS = 60_000

  const RPC_ABI = parseAbi([
    'function getPeripheryContract(string) view returns (address)',
    'function getWhitelistedSelectorsForContract(address) view returns (bytes4[])',
  ])
  const ZERO = '0x0000000000000000000000000000000000000000'

  let chain: {
    registered: Record<string, Address>
    selectors: Record<string, Hex[]>
    codeless: string[]
    /** Code per lowercased address, over a 24-byte default. */
    code?: Record<string, Hex>
    unreadable?: boolean
  }
  let server: Server
  let rpcUrl: string
  let sandbox: string
  let proposeLog: string

  const answer = (method: string, params: unknown[]): unknown => {
    if (method === 'eth_chainId') return '0x7a'
    if (method === 'eth_getCode') {
      const address = String(params[0]).toLowerCase()
      if (chain.codeless.includes(address)) return '0x'
      return chain.code?.[address] ?? `0x${'60'.repeat(24)}`
    }
    if (method === 'eth_call') {
      const data =
        (params[0] as { data?: Hex; input?: Hex }).data ??
        (params[0] as { input?: Hex }).input
      const call = decodeFunctionData({ abi: RPC_ABI, data: data as Hex })
      if (call.functionName !== 'getPeripheryContract' && chain.unreadable)
        throw new Error('stub: allowlist unreadable')
      if (call.functionName === 'getPeripheryContract')
        return encodeFunctionResult({
          abi: RPC_ABI,
          functionName: 'getPeripheryContract',
          result: chain.registered[call.args[0]] ?? ZERO,
        })
      return encodeFunctionResult({
        abi: RPC_ABI,
        functionName: 'getWhitelistedSelectorsForContract',
        result: chain.selectors[getAddress(call.args[0])] ?? [],
      })
    }
    throw new Error(`stub: unexpected ${method}`)
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const parsed = JSON.parse(body) as
          | { id: number; method: string; params: unknown[] }
          | { id: number; method: string; params: unknown[] }[]
        const one = (r: { id: number; method: string; params: unknown[] }) => {
          try {
            return {
              jsonrpc: '2.0',
              id: r.id,
              result: answer(r.method, r.params),
            }
          } catch (error) {
            return {
              jsonrpc: '2.0',
              id: r.id,
              error: { code: -32000, message: String(error) },
            }
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

    sandbox = mkdtempSync(join(tmpdir(), 'paired-periphery-cli-'))
    const shims = join(sandbox, 'shims')
    mkdirSync(shims)
    proposeLog = join(sandbox, 'propose.log')
    writeFileSync(
      join(shims, 'bunx'),
      `#!/bin/sh\necho "$*" >> "${proposeLog}"\nexit 0\n`,
      { mode: 0o755 }
    )
  })

  afterAll(() => {
    server.close()
    rmSync(sandbox, { recursive: true, force: true })
  })

  const run = async (args: string[]) => {
    rmSync(proposeLog, { force: true })
    const env: Record<string, string> = {
      PATH: `${join(sandbox, 'shims')}:${process.env.PATH ?? ''}`,
      HOME: sandbox,
      ETH_NODE_URI_FUSE: rpcUrl,
      ETH_NODE_URI_LENS: rpcUrl,
      SC_MONGODB_URI: 'blocked-in-tests://no-store',
      MONGODB_URI: 'blocked-in-tests://no-store',
      PRIVATE_KEY: 'malformed-in-tests',
      PRIVATE_KEY_PRODUCTION: 'malformed-in-tests',
      SAFE_SIGNER_PRIVATE_KEY: 'malformed-in-tests',
    }
    const child = spawn(TSX, [SCRIPT, ...args], { cwd: sandbox, env })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    const rc = await new Promise<number>((resolve) =>
      child.on('close', (code) => resolve(code ?? -1))
    )
    let proposals: string[] = []
    try {
      proposals = readFileSync(proposeLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
    } catch {
      proposals = []
    }
    if (out.includes('Proposal stored'))
      throw new Error('a probe reached a real proposal store')
    return { rc, out, proposals }
  }

  const common = ['--networks', 'fuse', '--diamond', DIAMOND]

  it(
    'proposes each paired registration on its own',
    async () => {
      chain = {
        registered: { TokenWrapper: OLD_WRAPPER },
        selectors: { [OLD_WRAPPER]: wrapperSelectors },
        codeless: [],
      }
      const { rc, proposals } = await run([
        '--contract',
        'TokenWrapper,GasZipPeriphery',
        '--address',
        `${NEW_WRAPPER},${NEW_GASZIP}`,
        ...common,
      ])
      expect(rc).toBe(0)
      expect(proposals).toHaveLength(2)
      for (const proposal of proposals)
        expect(proposal).toContain(
          'script/deploy/safe/propose-to-safe.ts --network fuse --timelock'
        )
      // wrapper batch: register, remove old, add new; gas zip: register, add
      expect(proposals[0]?.match(/--calldata/g)).toHaveLength(3)
      expect(proposals[1]?.match(/--calldata/g)).toHaveLength(2)
    },
    TIMEOUT_MS
  )

  it(
    'refuses before any proposal when one of the registrations has no code',
    async () => {
      chain = {
        registered: {},
        selectors: {},
        codeless: [NEW_GASZIP.toLowerCase()],
      }
      const { rc, out, proposals } = await run([
        '--contract',
        'TokenWrapper,GasZipPeriphery',
        '--address',
        `${NEW_WRAPPER},${NEW_GASZIP}`,
        ...common,
      ])
      expect(rc).toBe(EXIT_REFUSED)
      expect(out).toContain('no proposal created by this call')
      // TokenWrapper alone builds (case above); the refusal has to stop it too
      expect(proposals).toEqual([])
    },
    TIMEOUT_MS
  )

  it(
    'refuses a 2-byte stub and a 23-byte delegation before any proposal',
    async () => {
      const delegation = `0xef0100${'ab'.repeat(20)}` as Hex
      for (const code of ['0x6080' as Hex, delegation]) {
        chain = {
          registered: {},
          selectors: {},
          codeless: [],
          code: { [NEW_GASZIP.toLowerCase()]: code },
        }
        const { rc, out, proposals } = await run([
          '--contract',
          'TokenWrapper,GasZipPeriphery',
          '--address',
          `${NEW_WRAPPER},${NEW_GASZIP}`,
          ...common,
        ])
        expect(rc).toBe(EXIT_REFUSED)
        expect(out).toContain(`GasZipPeriphery ${NEW_GASZIP} has no code`)
        expect(proposals).toEqual([])
      }
    },
    TIMEOUT_MS
  )

  it(
    'removes a shared old address when --replacing names the other name moving off it',
    async () => {
      chain = {
        registered: { TokenWrapper: OLD_WRAPPER, GasZipPeriphery: OLD_WRAPPER },
        selectors: { [OLD_WRAPPER]: [...wrapperSelectors, GASZIP_A, GASZIP_B] },
        codeless: [],
      }
      const kept = await run([
        '--contract', 'TokenWrapper', '--address', NEW_WRAPPER, ...common,
      ]) // prettier-ignore
      const moved = await run([
        '--contract', 'TokenWrapper', '--address', NEW_WRAPPER,
        '--replacing', 'TokenWrapper,GasZipPeriphery', ...common,
      ]) // prettier-ignore
      expect(kept.rc).toBe(0)
      expect(moved.rc).toBe(0)
      // register + add, versus register + remove + add
      expect(kept.proposals[0]?.match(/--calldata/g)).toHaveLength(2)
      expect(moved.proposals[0]?.match(/--calldata/g)).toHaveLength(3)
    },
    TIMEOUT_MS
  )

  it(
    'says which networks were proposed when a later network is refused',
    async () => {
      chain = {
        registered: {},
        selectors: {},
        // lens's deploy-log TokenWrapper
        codeless: ['0x13a0486dceeb9908d09bad8136c0512d529383ac'],
      }
      const { rc, out, proposals } = await run([
        '--contract', 'TokenWrapper', '--networks', 'fuse,lens',
      ]) // prettier-ignore
      expect(rc).toBe(EXIT_REFUSED)
      expect(proposals).toHaveLength(1)
      expect(out).toContain('proposed before the refusal: fuse:TokenWrapper')
      expect(out).not.toContain('nothing was proposed')
    },
    TIMEOUT_MS
  )

  it(
    'refuses on unreadable chain state instead of proposing',
    async () => {
      chain = {
        registered: { TokenWrapper: OLD_WRAPPER },
        selectors: {},
        codeless: [],
        unreadable: true,
      }
      const { rc, out, proposals } = await run([
        '--contract', 'TokenWrapper', '--address', NEW_WRAPPER, ...common,
      ]) // prettier-ignore
      expect(rc).toBe(EXIT_REFUSED)
      expect(out).toContain('could not read the chain state of TokenWrapper')
      expect(proposals).toEqual([])
    },
    TIMEOUT_MS
  )

  it(
    'answers the preflight without proposing',
    async () => {
      chain = {
        registered: {},
        selectors: {},
        codeless: [FEE_COLLECTOR.toLowerCase()],
      }
      const paired = await run([
        '--contract', 'TokenWrapper', '--address', NEW_WRAPPER, '--preflight', ...common,
      ]) // prettier-ignore
      const plainCodeless = await run([
        '--contract', 'FeeCollector', '--address', FEE_COLLECTOR, '--preflight', ...common,
      ]) // prettier-ignore
      chain.codeless = []
      const plain = await run([
        '--contract', 'FeeCollector', '--address', FEE_COLLECTOR, '--preflight', ...common,
      ]) // prettier-ignore
      expect(paired.rc).toBe(0)
      expect(plain.rc).toBe(PREFLIGHT_EXIT_NOT_PAIRED)
      expect(plainCodeless.rc).toBe(EXIT_REFUSED)
      expect([
        ...paired.proposals,
        ...plain.proposals,
        ...plainCodeless.proposals,
      ]).toEqual([])
    },
    TIMEOUT_MS
  )
})
