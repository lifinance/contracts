/**
 * Tests that a Tron network's watch wires Tron's spellings and read limits into
 * the scan and the gates, over a stubbed JSON-RPC endpoint.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  pad,
  parseAbiParameters,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from 'viem'

import {
  evm20HexStringToTronBase58,
  getTronWebCodecOnlyForNetwork,
} from '@lifi/tron-devkit'

import type { INetworksObject } from '../../common/types'
import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'

import { computeOperationIdBatch } from './timelock-queue'
import {
  expectedWhitelist,
  loadWatcherState,
  watchNetwork,
  type INetworkFindings,
} from './timelock-watcher'
import { CALL_SCHEDULED_EVENT } from './timelock-watcher-scan'

const dir = mkdtempSync(join(tmpdir(), 'timelock-watcher-tron-watch-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const TIMELOCK_BASE58 = 'TBzBFjsCh3LJh9avAKy9oF3StZMn4hUBhu'
const TIMELOCK_HEX = getAddress('0x161f35951702e93ffee662ed16fb538c283462a5')
const DIAMOND_BASE58 = 'TBvVg3Aam5QP2XE3XCatgatjefXvsYf6yD'
const DIAMOND_HEX = getAddress('0x156cebba59deb2cb23742f70dcb0a11cc775591f')
const ZERO32: Hex = `0x${'0'.repeat(64)}`
/** Checksum-valid base58 under version byte 0x42, not Tron's 0x41. */
const OTHER_VERSION_BASE58 = 'TbKcWzjyNreUq3ub5hQFKUbCX7wyoDAGww'
/**
 * Main's Tron wallets share their bytes with the EVM ones, so a gate handed the
 * EVM config would still pass; the test pauser differs to tell them apart.
 */
const TRON_PAUSER_HEX = getAddress('0x00000000000000000000000000000000000000aa')
const TRON_PAUSER_BASE58 = evm20HexStringToTronBase58(
  getTronWebCodecOnlyForNetwork('tron'),
  TRON_PAUSER_HEX
)

describe('expectedWhitelist on Tron', () => {
  const whitelistNaming = (address: string) => async () => ({
    ok: true as const,
    value: {
      DEXS: [
        {
          contracts: {
            tron: [{ address, functions: { '0x12345678': 'swap()' } }],
          },
        },
      ],
    },
  })

  it('expands a base58 entry and keys it by hex', async () => {
    const read = await expectedWhitelist(
      'tron',
      {},
      whitelistNaming(TIMELOCK_BASE58)
    )
    expect(read).toEqual({
      pairs: new Set([`${TIMELOCK_HEX.toLowerCase()}:0x12345678`]),
    })
  })

  it('reports an entry that is not a Tron address', async () => {
    const read = await expectedWhitelist(
      'tron',
      {},
      whitelistNaming('Tnotanaddress')
    )
    expect('reason' in read && read.reason).toContain('not a Tron address')
  })

  it('keys an entry already spelled as hex by that hex', async () => {
    const read = await expectedWhitelist(
      'tron',
      {},
      whitelistNaming(TIMELOCK_HEX)
    )
    expect(read).toEqual({
      pairs: new Set([`${TIMELOCK_HEX.toLowerCase()}:0x12345678`]),
    })
  })

  it('reports an entry under another version byte', async () => {
    const read = await expectedWhitelist(
      'tron',
      {},
      whitelistNaming(OTHER_VERSION_BASE58)
    )
    expect('reason' in read && read.reason).toContain(
      'version byte is not 0x41'
    )
  })
})

describe('watchNetwork on Tron', () => {
  const HEAD = 20_000n
  const SCHEDULED_IN = 5_000n
  const TRON_LOG_SPAN = 5_000n
  const CALL_DATA: Hex = '0x12345678'
  const AGREED_DELAY = 10_800n // 3 hours, config/timelockController.json minDelay
  const UNKNOWN_TARGET = getAddress(
    '0x00000000000000000000000000000000000000bb'
  )

  const scheduledOperation = (target: Address, delay: bigint) => {
    const id = computeOperationIdBatch(
      [target],
      [0n],
      [CALL_DATA],
      ZERO32,
      ZERO32
    )
    const log = {
      address: TIMELOCK_HEX,
      topics: encodeEventTopics({
        abi: [CALL_SCHEDULED_EVENT],
        eventName: 'CallScheduled',
        args: { id, index: 0n },
      }),
      data: encodeAbiParameters(
        parseAbiParameters('address, uint256, bytes, bytes32, uint256'),
        [target, 0n, CALL_DATA, ZERO32, delay]
      ),
      blockNumber: toHex(SCHEDULED_IN),
      logIndex: '0x3',
      transactionIndex: '0x0',
      transactionHash: ZERO32,
      blockHash: ZERO32,
      removed: false,
    }
    return { id, log }
  }
  let scheduled = scheduledOperation(DIAMOND_HEX, AGREED_DELAY)
  const selector = (signature: string): string =>
    toFunctionSelector(signature).toLowerCase()
  const word = (value: bigint): Hex => pad(toHex(value), { size: 32 })
  const now = BigInt(Math.floor(Date.now() / 1000))

  interface IRpcCall {
    id: number
    method: string
    params: unknown[]
  }
  interface IBlockRange {
    fromBlock: Hex
    toBlock: Hex
  }
  const calls: IRpcCall[] = []
  const originalFetch = globalThis.fetch
  const originalRpcUrl = process.env['ETH_NODE_URI_TRON']
  const originalPauser = globalConfig.tronWallets.pauserWallet

  const ethCall = (data: string): unknown => {
    if (data.startsWith(selector('owner()'))) return pad(TIMELOCK_HEX)
    if (data.startsWith(selector('pauserWallet()'))) return pad(TRON_PAUSER_HEX)
    if (data.startsWith(selector('getMinDelay()'))) return word(864_000n)
    if (data.startsWith(selector('getTimestamp(bytes32)')))
      return word(now + 86_400n)
    throw new Error(`unstubbed eth_call ${data.slice(0, 10)}`)
  }

  const answer = ({ method, params }: IRpcCall): unknown => {
    if (method === 'eth_chainId') return toHex(728_126_428)
    if (method === 'eth_blockNumber') return toHex(HEAD)
    if (method === 'eth_getCode') return '0x6080'
    if (method === 'eth_getBlockByNumber')
      return {
        number: toHex(HEAD),
        timestamp: toHex(now),
        hash: ZERO32,
        parentHash: ZERO32,
        transactions: [],
      }
    if (method === 'eth_getLogs') {
      const range = params[0] as IBlockRange
      const inRange =
        SCHEDULED_IN >= BigInt(range.fromBlock) &&
        SCHEDULED_IN <= BigInt(range.toBlock)
      return inRange ? [scheduled.log] : []
    }
    if (method === 'eth_call')
      return ethCall(String((params[0] as { data?: Hex }).data).toLowerCase())
    throw new Error(`unstubbed ${method}`)
  }

  beforeEach(() => {
    calls.length = 0
    scheduled = scheduledOperation(DIAMOND_HEX, AGREED_DELAY)
    process.env['ETH_NODE_URI_TRON'] = 'https://tron.rpc.invalid/jsonrpc'
    globalConfig.tronWallets.pauserWallet = TRON_PAUSER_BASE58
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const call = JSON.parse(String(init?.body)) as IRpcCall
      calls.push(call)
      try {
        return Response.json({
          jsonrpc: '2.0',
          id: call.id,
          result: answer(call),
        })
      } catch (error) {
        return Response.json({
          jsonrpc: '2.0',
          id: call.id,
          error: { code: -32000, message: String(error) },
        })
      }
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    globalConfig.tronWallets.pauserWallet = originalPauser
    if (originalRpcUrl === undefined) {
      delete process.env['ETH_NODE_URI_TRON'] // spawn-env: in-process test, no child is spawned
    } else {
      process.env['ETH_NODE_URI_TRON'] = originalRpcUrl
    }
  })

  const runContext = async (): Promise<Parameters<typeof watchNetwork>[1]> =>
    ({
      state: await loadWatcherState(join(dir, 'no-state.json')),
      queue: new Map<string, Set<string>>(),
      signedSetExists: async () => true,
      historyBudget: 50,
      historyMs: 60_000,
      readPinned: async (path: string) =>
        path === 'deployments/tron.json'
          ? {
              ok: true as const,
              value: {
                LiFiTimelockController: TIMELOCK_BASE58,
                LiFiDiamond: DIAMOND_BASE58,
              },
            }
          : { ok: false as const, reason: 'fetch-failed' as const },
      readDeployLogHistory: async () => ({ ok: true, history: new Map() }),
      expired: new Set<string>(),
      found: new Map<string, INetworkFindings>(),
    }) as unknown as Parameters<typeof watchNetwork>[1]

  const callsOf = (method: string): IRpcCall[] =>
    calls.filter((c) => c.method === method)

  const watchTron = async (safeAddress?: string) => {
    const tron = (networks as unknown as INetworksObject)['tron']
    if (!tron) throw new Error('config/networks.json has no tron')
    const network = safeAddress ? { ...tron, safeAddress } : tron
    return watchNetwork(network, await runContext())
  }

  const onlyOperation = (report: Awaited<ReturnType<typeof watchNetwork>>) => {
    expect(report.operations.map((o) => o.id)).toEqual([scheduled.id])
    const [operation] = report.operations
    if (!operation) throw new Error('no operation reported')
    return {
      verdict: operation.verdict,
      statuses: Object.fromEntries(
        operation.checks.map((c) => [c.check, c.status])
      ),
      detailOf: (check: string) =>
        operation.checks.find((c) => c.check === check)?.detail ?? '',
    }
  }

  it('reads base58 deployments as hex, and the history from genesis', async () => {
    const report = await watchTron()

    expect(report.status).toBe('watched')
    expect(report.timelock).toBe(TIMELOCK_HEX)
    expect(report.notes.join('\n')).not.toContain('LiFiDiamond is owned by')
    expect(report.scan?.floor).toBe('0')
    expect(report.scan?.historyComplete).toBe(true)
    for (const read of callsOf('eth_getCode'))
      expect(read.params[1]).toBe('latest')

    const operation = onlyOperation(report)
    expect(operation.statuses).toEqual({
      'op-id': 'pass',
      state: 'pass',
      delay: 'pass',
      targets: 'pass',
      delegatecall: 'pass',
      authority: 'unknown',
      authorities: 'pass',
      codehash: 'unknown',
      rollback: 'pass',
    })
    expect(operation.detailOf('targets')).toBe('LiFiDiamond')
    expect(operation.verdict).toBe('unverified')
  })

  it('leaves Tron unreadable when its Safe is under another version byte', async () => {
    const report = await watchTron(OTHER_VERSION_BASE58)

    expect(report.status).toBe('unreadable')
    expect(report.reason).toContain('version byte is not 0x41')
    expect(report.operations).toEqual([])
  })

  it('watches Tron when its Safe is already spelled as hex', async () => {
    const report = await watchTron(TRON_PAUSER_HEX)

    expect(report.status).toBe('watched')
    expect(onlyOperation(report).statuses['targets']).toBe('pass')
  })

  it('fails the delay gate for a Tron operation scheduled below the agreed minimum', async () => {
    scheduled = scheduledOperation(DIAMOND_HEX, AGREED_DELAY - 1n)

    const operation = onlyOperation(await watchTron())

    expect(operation.statuses['delay']).toBe('fail')
    expect(operation.detailOf('delay')).toContain(
      `below the agreed ${AGREED_DELAY}s`
    )
    expect(operation.statuses['targets']).toBe('pass')
    expect(operation.verdict).toBe('mismatch')
  })

  it('fails the targets gate for a Tron call to an address main does not know', async () => {
    scheduled = scheduledOperation(UNKNOWN_TARGET, AGREED_DELAY)

    const operation = onlyOperation(await watchTron())

    expect(operation.statuses['targets']).toBe('fail')
    expect(operation.detailOf('targets')).toContain(UNKNOWN_TARGET)
    expect(operation.statuses['delay']).toBe('pass')
    expect(operation.verdict).toBe('mismatch')
  })

  it('keeps every log range within the Tron cap and leaves getTimestamp unpinned', async () => {
    await watchTron()

    const ranges = callsOf('eth_getLogs').map((c) => c.params[0] as IBlockRange)
    expect(ranges.length).toBeGreaterThan(0)
    for (const range of ranges)
      expect(
        BigInt(range.toBlock) - BigInt(range.fromBlock) + 1n
      ).toBeLessThanOrEqual(TRON_LOG_SPAN)

    const timestampReads = callsOf('eth_call').filter((c) =>
      String((c.params[0] as { data?: Hex }).data).startsWith(
        selector('getTimestamp(bytes32)')
      )
    )
    expect(timestampReads.length).toBeGreaterThan(0)
    for (const read of timestampReads) expect(read.params[1]).toBe('latest')
  })
})
