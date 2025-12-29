import { rmSync, writeFileSync } from 'node:fs'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'

import type { INetworkConfig } from './types'

let createPublicClientCalls: Array<{ chain: unknown; transport: unknown }> = []
let publicClientCode = '0x'
let httpCalls: Array<{ url: string; options: unknown }> = []
let fallbackCalls: Array<{ transports: unknown[]; options: unknown }> = []
let defineChainCalls: Array<{ id: number; name: string }> = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mongoDoc: any = null

mock.module('viem', () => {
  return {
    createPublicClient: mock(
      (options: { chain: unknown; transport: unknown }) => {
        createPublicClientCalls.push(options)
        return {
          getCode: mock(async () => publicClientCode),
        }
      }
    ),
    defineChain: mock((config: { id: number; name: string }) => {
      defineChainCalls.push({ id: config.id, name: config.name })
      return config
    }),
    fallback: mock((transports: unknown[], options: unknown) => {
      fallbackCalls.push({ transports, options })
      return { transports, options }
    }),
    http: mock((url: string, options: unknown) => {
      httpCalls.push({ url, options })
      return { url, options }
    }),
  }
})

mock.module('mongodb', () => {
  class MockCollection {
    public async findOne() {
      return mongoDoc
    }
  }

  class MockDb {
    public collection() {
      return new MockCollection()
    }
  }

  class MockMongoClient {
    public async connect() {
      return
    }

    public db() {
      return new MockDb()
    }

    public async close() {
      return
    }
  }

  return { MongoClient: MockMongoClient }
})

const rpcModule = await import('./rpc')

describe('rpc', () => {
  beforeEach(() => {
    createPublicClientCalls = []
    httpCalls = []
    fallbackCalls = []
    defineChainCalls = []
    mongoDoc = null
    publicClientCode = '0x'
  })

  afterEach(() => {
    delete process.env.ETH_NODE_URI_TESTNET
    delete process.env.MONGODB_URI
  })

  it('parses commented rpc entries', () => {
    const env = `# ETH_NODE_URI_TESTNET="https://rpc1"\n# ETH_NODE_URI_TESTNET='https://rpc2'\n`
    const entries = rpcModule.parseCommentedRpcEntries(
      env,
      'ETH_NODE_URI_TESTNET'
    )
    expect(entries.map((entry: { url: string }) => entry.url)).toEqual([
      'https://rpc1',
      'https://rpc2',
    ])
  })

  it('returns env rpc endpoint and dedupes', () => {
    process.env.ETH_NODE_URI_TESTNET = 'https://rpc.example'
    const endpoint = rpcModule.getEnvRpcEndpoint('ETH_NODE_URI_TESTNET')
    expect(endpoint?.url).toBe('https://rpc.example')

    const deduped = rpcModule.dedupeRpcEndpoints([
      { url: 'https://rpc.example', source: 'env' },
      { url: 'https://rpc.example', source: 'env' },
      { url: 'https://rpc2', source: 'env' },
    ])
    expect(deduped.length).toBe(2)
  })

  it('classifies transient errors and builds retry delay', () => {
    expect(rpcModule.isTransientRpcError(new Error('timeout'))).toBeTrue()
    expect(rpcModule.isTransientRpcError(new Error('execution reverted'))).toBe(
      false
    )
    expect(rpcModule.buildRetryDelay(500, 2)).toBe(2000)
  })

  it('builds rpc pool from env and caches public client', async () => {
    process.env.ETH_NODE_URI_TESTNET = 'https://rpc.example'

    const network = {
      id: 'testnet',
      name: 'Testnet',
      chainId: 123,
      nativeCurrency: 'ETH',
      rpcUrl: 'https://rpc.default',
      nativeAddress: '0x0',
      wrappedNativeAddress: '0x0',
      status: 'active',
      type: 'evm',
      verificationType: 'etherscan',
      explorerUrl: '',
      explorerApiUrl: '',
      multicallAddress: '0x0000000000000000000000000000000000000000',
      safeAddress: '',
      deployedWithEvmVersion: 'cancun',
      deployedWithSolcVersion: '0.8.29',
      gasZipChainId: 0,
      isZkEVM: false,
    }

    const pool = new rpcModule.RpcPool('env', {
      retryCount: 2,
      retryDelayMs: 100,
      timeoutMs: 5000,
    })

    const client = await pool.getPublicClient(network as INetworkConfig)
    const secondClient = await pool.getPublicClient(network as INetworkConfig)

    expect(client).toBe(secondClient)
    expect(createPublicClientCalls.length).toBe(1)
    expect(httpCalls.length).toBe(1)
    expect(defineChainCalls.length).toBe(1)
  })

  it('uses fallback transport when multiple endpoints are configured', async () => {
    process.env.ETH_NODE_URI_TESTNET = 'https://rpc.primary'
    const envFile = '.env.test.rpc'
    writeFileSync(
      envFile,
      '# ETH_NODE_URI_TESTNET="https://rpc.backup"\n',
      'utf8'
    )

    const network = {
      id: 'testnet',
      name: 'Testnet',
      chainId: 123,
      nativeCurrency: 'ETH',
      rpcUrl: 'https://rpc.default',
      nativeAddress: '0x0',
      wrappedNativeAddress: '0x0',
      status: 'active',
      type: 'evm',
      verificationType: 'etherscan',
      explorerUrl: '',
      explorerApiUrl: '',
      multicallAddress: '0x0000000000000000000000000000000000000000',
      safeAddress: '',
      deployedWithEvmVersion: 'cancun',
      deployedWithSolcVersion: '0.8.29',
      gasZipChainId: 0,
      isZkEVM: false,
    }

    const pool = new rpcModule.RpcPool(
      'env-commented',
      {
        retryCount: 1,
        retryDelayMs: 50,
        timeoutMs: 5000,
      },
      envFile
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await pool.getPublicClient(network as any)
    expect(fallbackCalls.length).toBe(1)

    rmSync(envFile, { force: true })
  })

  it('gets code from public client', async () => {
    process.env.ETH_NODE_URI_TESTNET = 'https://rpc.example'
    publicClientCode = '0x1234'

    const network = {
      id: 'testnet',
      name: 'Testnet',
      chainId: 123,
      nativeCurrency: 'ETH',
      rpcUrl: 'https://rpc.default',
      nativeAddress: '0x0',
      wrappedNativeAddress: '0x0',
      status: 'active',
      type: 'evm',
      verificationType: 'etherscan',
      explorerUrl: '',
      explorerApiUrl: '',
      multicallAddress: '0x0000000000000000000000000000000000000000',
      safeAddress: '',
      deployedWithEvmVersion: 'cancun',
      deployedWithSolcVersion: '0.8.29',
      gasZipChainId: 0,
      isZkEVM: false,
    }

    const pool = new rpcModule.RpcPool('env', {
      retryCount: 1,
      retryDelayMs: 50,
      timeoutMs: 5000,
    })

    const code = await pool.getCode(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      network as any,
      '0x0000000000000000000000000000000000000001'
    )
    expect(code).toBe('0x1234')
  })

  it('handles commented env rpc endpoints', async () => {
    process.env.ETH_NODE_URI_TESTNET = 'https://rpc.primary'
    const envFile = '.env.test.rpc'
    writeFileSync(
      envFile,
      '# ETH_NODE_URI_TESTNET="https://rpc.fallback"\n',
      'utf8'
    )

    const network = {
      id: 'testnet',
      name: 'Testnet',
      chainId: 123,
      nativeCurrency: 'ETH',
      rpcUrl: 'https://rpc.default',
      nativeAddress: '0x0',
      wrappedNativeAddress: '0x0',
      status: 'active',
      type: 'evm',
      verificationType: 'etherscan',
      explorerUrl: '',
      explorerApiUrl: '',
      multicallAddress: '0x0000000000000000000000000000000000000000',
      safeAddress: '',
      deployedWithEvmVersion: 'cancun',
      deployedWithSolcVersion: '0.8.29',
      gasZipChainId: 0,
      isZkEVM: false,
    }

    const pool = new rpcModule.RpcPool(
      'env-commented',
      {
        retryCount: 1,
        retryDelayMs: 50,
        timeoutMs: 5000,
      },
      envFile
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endpoints = await pool.getRpcEndpoints(network as any)
    expect(endpoints.length).toBe(2)

    rmSync(envFile, { force: true })
  })

  it('handles missing env file for commented rpc source', async () => {
    process.env.ETH_NODE_URI_TESTNET = 'https://rpc.primary'

    const network = {
      id: 'testnet',
      name: 'Testnet',
      chainId: 123,
      nativeCurrency: 'ETH',
      rpcUrl: 'https://rpc.default',
      nativeAddress: '0x0',
      wrappedNativeAddress: '0x0',
      status: 'active',
      type: 'evm',
      verificationType: 'etherscan',
      explorerUrl: '',
      explorerApiUrl: '',
      multicallAddress: '0x0000000000000000000000000000000000000000',
      safeAddress: '',
      deployedWithEvmVersion: 'cancun',
      deployedWithSolcVersion: '0.8.29',
      gasZipChainId: 0,
      isZkEVM: false,
    }

    const pool = new rpcModule.RpcPool(
      'env-commented',
      {
        retryCount: 1,
        retryDelayMs: 50,
        timeoutMs: 5000,
      },
      'missing.env'
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endpoints = await pool.getRpcEndpoints(network as any)
    expect(endpoints.length).toBe(1)
  })

  it('fetches rpc endpoints from mongo', async () => {
    process.env.MONGODB_URI = 'mongodb://mock'
    mongoDoc = {
      chainName: 'testnet',
      rpcs: [
        { url: 'https://rpc1', priority: 1, isActive: true },
        { url: 'https://rpc2', priority: 5, isActive: true },
      ],
    }

    const network = {
      id: 'testnet',
      name: 'Testnet',
      chainId: 123,
      nativeCurrency: 'ETH',
      rpcUrl: 'https://rpc.default',
      nativeAddress: '0x0',
      wrappedNativeAddress: '0x0',
      status: 'active',
      type: 'evm',
      verificationType: 'etherscan',
      explorerUrl: '',
      explorerApiUrl: '',
      multicallAddress: '0x0000000000000000000000000000000000000000',
      safeAddress: '',
      deployedWithEvmVersion: 'cancun',
      deployedWithSolcVersion: '0.8.29',
      gasZipChainId: 0,
      isZkEVM: false,
    }

    const pool = new rpcModule.RpcPool('mongo', {
      retryCount: 1,
      retryDelayMs: 50,
      timeoutMs: 5000,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endpoints = await pool.getRpcEndpoints(network as any)
    expect(endpoints[0]?.url).toBe('https://rpc2')
  })

  it('throws when env rpc is missing and handles describeEndpoints', async () => {
    const pool = new rpcModule.RpcPool('env', {
      retryCount: 1,
      retryDelayMs: 50,
      timeoutMs: 5000,
    })

    const network = {
      id: 'testnet',
      name: 'Testnet',
      chainId: 123,
      nativeCurrency: 'ETH',
      rpcUrl: 'https://rpc.default',
      nativeAddress: '0x0',
      wrappedNativeAddress: '0x0',
      status: 'active',
      type: 'evm',
      verificationType: 'etherscan',
      explorerUrl: '',
      explorerApiUrl: '',
      multicallAddress: '0x0000000000000000000000000000000000000000',
      safeAddress: '',
      deployedWithEvmVersion: 'cancun',
      deployedWithSolcVersion: '0.8.29',
      gasZipChainId: 0,
      isZkEVM: false,
    }

    // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-explicit-any
    await expect(pool.getRpcEndpoints(network as any)).rejects.toThrow(
      'Missing RPC env var'
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endpoints = await pool.describeEndpoints(network as any)
    expect(endpoints).toEqual([])
  })

  it('returns endpoints from describeEndpoints when available', async () => {
    process.env.ETH_NODE_URI_TESTNET = 'https://rpc.example'
    const pool = new rpcModule.RpcPool('env', {
      retryCount: 1,
      retryDelayMs: 50,
      timeoutMs: 5000,
    })

    const network = {
      id: 'testnet',
      name: 'Testnet',
      chainId: 123,
      nativeCurrency: 'ETH',
      rpcUrl: 'https://rpc.default',
      nativeAddress: '0x0',
      wrappedNativeAddress: '0x0',
      status: 'active',
      type: 'evm',
      verificationType: 'etherscan',
      explorerUrl: '',
      explorerApiUrl: '',
      multicallAddress: '0x0000000000000000000000000000000000000000',
      safeAddress: '',
      deployedWithEvmVersion: 'cancun',
      deployedWithSolcVersion: '0.8.29',
      gasZipChainId: 0,
      isZkEVM: false,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endpoints = await pool.describeEndpoints(network as any)
    expect(endpoints[0]?.url).toBe('https://rpc.example')
  })

  it('throws when mongo source has no uri or endpoints', async () => {
    const network = {
      id: 'testnet',
      name: 'Testnet',
      chainId: 123,
      nativeCurrency: 'ETH',
      rpcUrl: 'https://rpc.default',
      nativeAddress: '0x0',
      wrappedNativeAddress: '0x0',
      status: 'active',
      type: 'evm',
      verificationType: 'etherscan',
      explorerUrl: '',
      explorerApiUrl: '',
      multicallAddress: '0x0000000000000000000000000000000000000000',
      safeAddress: '',
      deployedWithEvmVersion: 'cancun',
      deployedWithSolcVersion: '0.8.29',
      gasZipChainId: 0,
      isZkEVM: false,
    }

    const pool = new rpcModule.RpcPool('mongo', {
      retryCount: 1,
      retryDelayMs: 50,
      timeoutMs: 5000,
    })

    // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-explicit-any
    await expect(pool.getRpcEndpoints(network as any)).rejects.toThrow(
      'MONGODB_URI is required'
    )

    process.env.MONGODB_URI = 'mongodb://mock'
    mongoDoc = { chainName: 'testnet', rpcs: [] }
    // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-explicit-any
    await expect(pool.getRpcEndpoints(network as any)).rejects.toThrow(
      'No RPC endpoints found'
    )
  })
})
