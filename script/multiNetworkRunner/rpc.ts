import { readFileSync } from 'node:fs'

import { consola } from 'consola'
import { MongoClient } from 'mongodb'
import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  type PublicClient,
} from 'viem'

import { getRPCEnvVarName } from '../utils/network'

import type { INetworkConfig, IRpcEndpoint, IRetryConfig } from './types'

export type RpcSource = 'env' | 'env-commented' | 'mongo'

const parseEnvLineValue = (value: string): string => {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1)
  return trimmed
}

export const parseCommentedRpcEntries = (
  envContents: string,
  envVarName: string
): IRpcEndpoint[] => {
  const entries: IRpcEndpoint[] = []
  const lines = envContents.split(/\r?\n/)
  const pattern = new RegExp(`^\\s*#\\s*${envVarName}\\s*=\\s*(.+)$`, 'u')

  for (const line of lines) {
    const match = line.match(pattern)
    if (!match) continue
    const url = parseEnvLineValue(match[1] ?? '')
    if (!url) continue
    entries.push({ url, source: 'env-commented' })
  }

  return entries
}

export const getEnvRpcEndpoint = (envVarName: string): IRpcEndpoint | null => {
  const raw = process.env[envVarName]
  if (!raw) return null
  return { url: raw, source: 'env', isActive: true }
}

export const dedupeRpcEndpoints = (
  endpoints: IRpcEndpoint[]
): IRpcEndpoint[] => {
  const seen = new Set<string>()
  const deduped: IRpcEndpoint[] = []
  for (const endpoint of endpoints) {
    const key = endpoint.url.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    deduped.push(endpoint)
  }
  return deduped
}

export const isTransientRpcError = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase()

  const transientMarkers = [
    'timeout',
    'timed out',
    'etimedout',
    'ecconnreset',
    'econnreset',
    'econnrefused',
    'enotfound',
    '503',
    '502',
    '504',
    'gateway',
    'rate limit',
    '429',
    'temporarily unavailable',
    'bad gateway',
  ]

  const nonTransientMarkers = [
    'execution reverted',
    'revert',
    'invalid argument',
  ]

  if (nonTransientMarkers.some((marker) => message.includes(marker)))
    return false

  return transientMarkers.some((marker) => message.includes(marker))
}

export const buildRetryDelay = (
  baseDelayMs: number,
  attempt: number
): number => {
  const backoff = Math.pow(2, attempt)
  return Math.max(baseDelayMs, baseDelayMs * backoff)
}

const buildViemChain = (network: INetworkConfig) => {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: {
      decimals: 18,
      name: network.nativeCurrency,
      symbol: network.nativeCurrency,
    },
    rpcUrls: {
      default: { http: [network.rpcUrl] },
    },
  })
}

export class RpcPool {
  private readonly cache = new Map<string, PublicClient>()

  public constructor(
    private readonly source: RpcSource,
    private readonly retryConfig: IRetryConfig,
    private readonly envFilePath = '.env'
  ) {}

  public async getRpcEndpoints(
    network: INetworkConfig
  ): Promise<IRpcEndpoint[]> {
    if (this.source === 'mongo') {
      return this.getRpcEndpointsFromMongo(network)
    }

    const envVarName = getRPCEnvVarName(network.id)
    const primary = getEnvRpcEndpoint(envVarName)

    if (!primary) {
      throw new Error(`Missing RPC env var ${envVarName} for ${network.id}`)
    }

    if (this.source === 'env-commented') {
      let envContents = ''
      try {
        envContents = readFileSync(this.envFilePath, 'utf8')
      } catch (error) {
        consola.warn(
          `Unable to read ${this.envFilePath} for commented RPCs: ${
            (error as Error).message
          }`
        )
      }
      const commented = parseCommentedRpcEntries(envContents, envVarName)
      return dedupeRpcEndpoints([primary, ...commented])
    }

    return [primary]
  }

  private async getRpcEndpointsFromMongo(
    network: INetworkConfig
  ): Promise<IRpcEndpoint[]> {
    const mongoUri = process.env.MONGODB_URI
    if (!mongoUri) {
      throw new Error('MONGODB_URI is required for mongo RPC source')
    }

    const client = new MongoClient(mongoUri)
    await client.connect()
    try {
      const db = client.db('blockchain-configs')
      const collection = db.collection('RpcEndpoints')
      const doc = await collection.findOne({ chainName: network.id })
      const rpcs = Array.isArray(doc?.rpcs) ? doc.rpcs : []
      const endpoints = rpcs
        .filter(
          (rpc: { url?: string; isActive?: boolean }) =>
            !!rpc.url && rpc.isActive !== false
        )
        .map((rpc: { url: string; priority?: number; isActive?: boolean }) => ({
          url: rpc.url,
          priority: rpc.priority,
          isActive: rpc.isActive,
          source: 'mongo' as const,
        }))
        .sort(
          (a: IRpcEndpoint, b: IRpcEndpoint) =>
            (b.priority ?? 0) - (a.priority ?? 0)
        )

      if (endpoints.length === 0) {
        throw new Error(`No RPC endpoints found in MongoDB for ${network.id}`)
      }

      return endpoints
    } finally {
      await client.close()
    }
  }

  public async getPublicClient(network: INetworkConfig): Promise<PublicClient> {
    const cached = this.cache.get(network.id)
    if (cached) return cached

    const endpoints = await this.getRpcEndpoints(network)
    const transport = this.buildTransport(endpoints)
    if (!transport) throw new Error('Failed to build transport')
    const chain = buildViemChain(network)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createPublicClient({ chain, transport: transport as any })

    this.cache.set(network.id, client)
    return client
  }

  public async getCode(
    network: INetworkConfig,
    address: `0x${string}`
  ): Promise<string> {
    const client = await this.getPublicClient(network)
    const code = await client.getCode({ address })
    return code ?? '0x'
  }

  private buildTransport(
    endpoints: IRpcEndpoint[]
  ): ReturnType<typeof http> | ReturnType<typeof fallback> | undefined {
    const { retryCount, retryDelayMs, timeoutMs } = this.retryConfig

    const retryDelayFn = (attempt: number) =>
      buildRetryDelay(retryDelayMs, attempt)

    const transports = endpoints.map((endpoint) =>
      http(endpoint.url, {
        retryCount,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        retryDelay: retryDelayFn as any,
        timeout: timeoutMs,
      })
    )

    if (transports.length === 1) {
      const transport = transports[0]
      if (!transport) throw new Error('No transport available')
      return transport
    }

    return fallback(transports, {
      retryCount,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      retryDelay: retryDelayFn as any,
      shouldThrow: (error) => !isTransientRpcError(error),
    })
  }

  public async describeEndpoints(
    network: INetworkConfig
  ): Promise<IRpcEndpoint[]> {
    try {
      return await this.getRpcEndpoints(network)
    } catch (error) {
      consola.warn(`RPC endpoints unavailable for ${network.id}: ${error}`)
      return []
    }
  }
}
