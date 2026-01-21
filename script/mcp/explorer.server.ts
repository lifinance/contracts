import { existsSync, readFileSync } from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const isSmokeTest: boolean = process.argv.includes('--smoke-test')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')

interface IHttpResponse {
  statusCode: number
  raw: string
  json: unknown
}

type UnknownRecord = Record<string, unknown>

function isRecord(v: unknown): v is UnknownRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function getString(obj: UnknownRecord, key: string): string | null {
  const v = obj[key]
  return typeof v === 'string' ? v : null
}

function httpsJson(method: string, url: string): Promise<IHttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        method,
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          accept: 'application/json',
        },
      },
      (res) => {
        let raw = ''
        res.on('data', (d) => (raw += d.toString()))
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0
          let parsed: unknown = null
          try {
            parsed = raw ? JSON.parse(raw) : null
          } catch {
            // keep parsed as null
          }
          resolve({ statusCode, raw, json: parsed })
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

type NetworksLoad =
  | { ok: true; networks: Record<string, unknown> }
  | { ok: false; error: string }

function loadNetworks(): NetworksLoad {
  const networksPath = path.join(repoRoot, 'config', 'networks.json')
  if (!existsSync(networksPath))
    return { ok: false, error: `Missing ${networksPath}` }
  try {
    const raw = readFileSync(networksPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return { ok: true, networks: parsed }
  } catch (e) {
    return {
      ok: false,
      error: `Failed to parse config/networks.json: ${String(e)}`,
    }
  }
}

function loadFoundryEtherscanKeyEnvVars(): Record<string, string> {
  const filePath = path.join(repoRoot, 'foundry.toml')
  if (!existsSync(filePath)) return {}
  const raw = readFileSync(filePath, 'utf8')

  const sectionStart = raw.indexOf('[etherscan]')
  if (sectionStart === -1) return {}
  const after = raw.slice(sectionStart + '[etherscan]'.length)

  const lines = after.split('\n')
  const out: Record<string, string> = {}
  for (const line of lines) {
    // stop at next section
    if (line.trim().startsWith('[')) break
    const m = line.match(/^([a-z0-9_]+)\s*=\s*\{\s*key\s*=\s*"\$\{([^}]+)\}"/i)
    if (!m) continue
    const network = m[1]
    const envVar = m[2]
    if (!network || !envVar) continue
    out[network] = envVar
  }
  return out
}

const networksLoad = loadNetworks()
const networks: Record<string, unknown> = networksLoad.ok
  ? networksLoad.networks
  : {}
const foundryKeyEnvVarByNetwork: Record<string, string> =
  loadFoundryEtherscanKeyEnvVars()

interface INetworkConfig {
  chainId?: number
  verificationType?: string
  explorerApiUrl?: string
}

function asNetworkConfig(v: unknown): INetworkConfig {
  const o = v as Record<string, unknown>
  return {
    chainId: typeof o?.chainId === 'number' ? o.chainId : undefined,
    verificationType:
      typeof o?.verificationType === 'string' ? o.verificationType : undefined,
    explorerApiUrl:
      typeof o?.explorerApiUrl === 'string' ? o.explorerApiUrl : undefined,
  }
}

function isSupportedNetworkConfig(n: INetworkConfig): boolean {
  const vt = (n.verificationType ?? '').toLowerCase()
  const apiUrl = n.explorerApiUrl
  if (!apiUrl || apiUrl === 'n/a') return false
  return vt === 'etherscan' || vt === 'blockscout' || vt === 'routescan'
}

type ResolveNetworkResult =
  | { ok: true; key: string; net: INetworkConfig }
  | { ok: false; error: string }

function resolveNetwork({
  network,
  chainId,
}: {
  network?: string
  chainId?: number
}): ResolveNetworkResult {
  const fallbackNetwork = process.env.EXPLORER_NETWORK
  const effectiveNetwork = network ?? fallbackNetwork

  if (effectiveNetwork && networks[effectiveNetwork]) {
    return {
      ok: true,
      key: effectiveNetwork,
      net: asNetworkConfig(networks[effectiveNetwork]),
    }
  }

  if (chainId !== undefined && chainId !== null) {
    const cid = Number(chainId)
    for (const [k, v] of Object.entries(networks)) {
      const net = asNetworkConfig(v)
      if (Number(net.chainId) === cid) return { ok: true, key: k, net }
    }
    return { ok: false, error: `Unknown chainId: ${cid}` }
  }

  return {
    ok: false,
    error: 'Missing network/chainId (set tool args or EXPLORER_NETWORK)',
  }
}

type ResolveExplorerApiResult =
  | {
      ok: true
      baseUrl: string
      apiKey?: string
      resolvedFrom: string
      apiKeyEnvVar?: string
    }
  | { ok: false; error: string }

function resolveExplorerApi({
  network,
  chainId,
  explorerApiUrlOverride,
  apiKeyOverride,
}: {
  network?: string
  chainId?: number
  explorerApiUrlOverride?: string
  apiKeyOverride?: string
}): ResolveExplorerApiResult {
  // Backwards-compatible single-base-url mode
  if (process.env.EXPLORER_API_BASE_URL) {
    return {
      ok: true,
      baseUrl: process.env.EXPLORER_API_BASE_URL,
      apiKey: apiKeyOverride ?? process.env.EXPLORER_API_KEY,
      resolvedFrom: 'EXPLORER_API_BASE_URL',
    }
  }

  if (explorerApiUrlOverride) {
    return {
      ok: true,
      baseUrl: explorerApiUrlOverride,
      apiKey: apiKeyOverride ?? process.env.EXPLORER_API_KEY,
      resolvedFrom: 'override',
    }
  }

  const r = resolveNetwork({ network, chainId })
  if (!r.ok) return r

  if (!isSupportedNetworkConfig(r.net)) {
    return {
      ok: false,
      error:
        `Network "${r.key}" is not supported by this explorer MCP server.\n` +
        `Supported verificationType: etherscan | blockscout | routescan`,
    }
  }

  const baseUrl = r.net.explorerApiUrl as string
  const envVar = foundryKeyEnvVarByNetwork[r.key]
  const apiKeyFromEnv =
    envVar && envVar !== 'NO_ETHERSCAN_API_KEY_REQUIRED'
      ? process.env[envVar]
      : undefined

  return {
    ok: true,
    baseUrl,
    apiKey: apiKeyOverride ?? apiKeyFromEnv ?? process.env.EXPLORER_API_KEY,
    resolvedFrom: `config/networks.json (${r.key})`,
    apiKeyEnvVar: envVar,
  }
}

function smokeTest(): void {
  if (!networksLoad.ok) {
    // eslint-disable-next-line no-console
    console.error(`explorer smoke test failed: ${networksLoad.error}`)
    process.exit(1)
  }
  const supported = Object.values(networks)
    .map(asNetworkConfig)
    .filter(isSupportedNetworkConfig).length
  if (supported === 0) {
    // eslint-disable-next-line no-console
    console.error(
      'explorer smoke test failed: no supported networks found in config/networks.json'
    )
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.error(`explorer smoke test ok (supported networks: ${supported})`)
  process.exit(0)
}

function buildUrl(
  baseUrl: string,
  params: Record<string, string | number | undefined>
): string {
  const u = new URL(baseUrl)
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return
    u.searchParams.set(k, String(v))
  })
  return u.toString()
}

const server = new McpServer({
  name: 'lifi-explorer',
  version: '0.1.0',
})

server.tool(
  'explorer_list_networks',
  'List supported networks from config/networks.json.',
  {},
  async () => {
    if (!networksLoad.ok) {
      return { content: [{ type: 'text', text: networksLoad.error }] }
    }
    const rows = Object.entries(networks)
      .map(([k, v]) => ({ k, v: asNetworkConfig(v) }))
      .filter((x) => isSupportedNetworkConfig(x.v))
      .map((x) => ({
        network: x.k,
        chainId: x.v.chainId,
        verificationType: x.v.verificationType,
        explorerApiUrl: x.v.explorerApiUrl,
        apiKeyEnvVar: foundryKeyEnvVarByNetwork[x.k] ?? '',
      }))
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
  }
)

const baseExplorerArgsSchema = {
  network: z
    .string()
    .optional()
    .describe(
      'Network key from config/networks.json (e.g. "mainnet", "base").'
    ),
  chainId: z.number().optional().describe('Chain ID (e.g. 1).'),
  explorerApiUrlOverride: z
    .string()
    .optional()
    .describe('Optional override for explorer API URL (advanced).'),
  apiKeyOverride: z
    .string()
    .optional()
    .describe('Optional override for API key (advanced).'),
}

server.tool(
  'explorer_get_abi',
  'Fetch contract ABI via explorer API (Etherscan-style; works with many Blockscout instances too).',
  {
    address: z.string().describe('Contract address.'),
    ...baseExplorerArgsSchema,
  },
  async ({
    address,
    network,
    chainId,
    explorerApiUrlOverride,
    apiKeyOverride,
  }: {
    address: string
    network?: string
    chainId?: number
    explorerApiUrlOverride?: string
    apiKeyOverride?: string
  }) => {
    const cfg = resolveExplorerApi({
      network,
      chainId,
      explorerApiUrlOverride,
      apiKeyOverride,
    })
    if (!cfg.ok)
      return {
        content: [{ type: 'text', text: `${cfg.error}\nSee docs/MCP.md.` }],
      }

    const url = buildUrl(cfg.baseUrl, {
      module: 'contract',
      action: 'getabi',
      address,
      apikey: cfg.apiKey,
    })

    const res = await httpsJson('GET', url)
    return {
      content: [
        {
          type: 'text',
          text:
            `statusCode: ${res.statusCode}\n\n` +
            (res.json ? JSON.stringify(res.json, null, 2) : res.raw),
        },
      ],
    }
  }
)

server.tool(
  'explorer_get_source_code',
  'Fetch verified source code metadata via explorer API (Etherscan-style; often compatible with Blockscout).',
  {
    address: z.string().describe('Contract address.'),
    ...baseExplorerArgsSchema,
  },
  async ({
    address,
    network,
    chainId,
    explorerApiUrlOverride,
    apiKeyOverride,
  }: {
    address: string
    network?: string
    chainId?: number
    explorerApiUrlOverride?: string
    apiKeyOverride?: string
  }) => {
    const cfg = resolveExplorerApi({
      network,
      chainId,
      explorerApiUrlOverride,
      apiKeyOverride,
    })
    if (!cfg.ok)
      return {
        content: [{ type: 'text', text: `${cfg.error}\nSee docs/MCP.md.` }],
      }

    const url = buildUrl(cfg.baseUrl, {
      module: 'contract',
      action: 'getsourcecode',
      address,
      apikey: cfg.apiKey,
    })

    const res = await httpsJson('GET', url)
    return {
      content: [
        {
          type: 'text',
          text:
            `statusCode: ${res.statusCode}\n\n` +
            (res.json ? JSON.stringify(res.json, null, 2) : res.raw),
        },
      ],
    }
  }
)

server.tool(
  'explorer_proxy_tx_by_hash',
  'Fetch transaction by hash via explorer "proxy" API (if supported by the explorer).',
  {
    txHash: z.string().describe('Transaction hash (0x...).'),
    ...baseExplorerArgsSchema,
  },
  async ({
    txHash,
    network,
    chainId,
    explorerApiUrlOverride,
    apiKeyOverride,
  }: {
    txHash: string
    network?: string
    chainId?: number
    explorerApiUrlOverride?: string
    apiKeyOverride?: string
  }) => {
    const cfg = resolveExplorerApi({
      network,
      chainId,
      explorerApiUrlOverride,
      apiKeyOverride,
    })
    if (!cfg.ok)
      return {
        content: [{ type: 'text', text: `${cfg.error}\nSee docs/MCP.md.` }],
      }

    const url = buildUrl(cfg.baseUrl, {
      module: 'proxy',
      action: 'eth_getTransactionByHash',
      txhash: txHash,
      apikey: cfg.apiKey,
    })

    const res = await httpsJson('GET', url)
    return {
      content: [
        {
          type: 'text',
          text:
            `statusCode: ${res.statusCode}\n\n` +
            (res.json ? JSON.stringify(res.json, null, 2) : res.raw),
        },
      ],
    }
  }
)

server.tool(
  'explorer_proxy_receipt_by_hash',
  'Fetch transaction receipt by hash via explorer "proxy" API (if supported by the explorer).',
  {
    txHash: z.string().describe('Transaction hash (0x...).'),
    ...baseExplorerArgsSchema,
  },
  async ({
    txHash,
    network,
    chainId,
    explorerApiUrlOverride,
    apiKeyOverride,
  }: {
    txHash: string
    network?: string
    chainId?: number
    explorerApiUrlOverride?: string
    apiKeyOverride?: string
  }) => {
    const cfg = resolveExplorerApi({
      network,
      chainId,
      explorerApiUrlOverride,
      apiKeyOverride,
    })
    if (!cfg.ok)
      return {
        content: [{ type: 'text', text: `${cfg.error}\nSee docs/MCP.md.` }],
      }

    const url = buildUrl(cfg.baseUrl, {
      module: 'proxy',
      action: 'eth_getTransactionReceipt',
      txhash: txHash,
      apikey: cfg.apiKey,
    })

    const res = await httpsJson('GET', url)
    return {
      content: [
        {
          type: 'text',
          text:
            `statusCode: ${res.statusCode}\n\n` +
            (res.json ? JSON.stringify(res.json, null, 2) : res.raw),
        },
      ],
    }
  }
)

server.tool(
  'explorer_contract_summary',
  'Fetch contract source metadata via explorer API and return a compact summary (prefer this over `explorer_get_source_code` for token efficiency).',
  {
    address: z.string().describe('Contract address.'),
    ...baseExplorerArgsSchema,
  },
  async ({
    address,
    network,
    chainId,
    explorerApiUrlOverride,
    apiKeyOverride,
  }: {
    address: string
    network?: string
    chainId?: number
    explorerApiUrlOverride?: string
    apiKeyOverride?: string
  }) => {
    const cfg = resolveExplorerApi({
      network,
      chainId,
      explorerApiUrlOverride,
      apiKeyOverride,
    })
    if (!cfg.ok)
      return {
        content: [{ type: 'text', text: `${cfg.error}\nSee docs/MCP.md.` }],
      }

    const url = buildUrl(cfg.baseUrl, {
      module: 'contract',
      action: 'getsourcecode',
      address,
      apikey: cfg.apiKey,
    })

    const res = await httpsJson('GET', url)

    const rawJson = isRecord(res.json) ? res.json : null
    const resultArr =
      rawJson && Array.isArray(rawJson.result) ? rawJson.result : null
    const first =
      resultArr && resultArr.length > 0 && isRecord(resultArr[0])
        ? resultArr[0]
        : null

    const summary = {
      statusCode: res.statusCode,
      resolvedFrom: cfg.resolvedFrom,
      network: network ?? null,
      chainId: chainId ?? null,
      address,
      ok: Boolean(first),
      // Common Etherscan/Blockscout fields
      contractName: first ? getString(first, 'ContractName') : null,
      compilerVersion: first ? getString(first, 'CompilerVersion') : null,
      optimizationUsed: first ? first.OptimizationUsed ?? null : null,
      runs: first ? first.Runs ?? null : null,
      evmVersion: first ? getString(first, 'EVMVersion') : null,
      licenseType: first ? first.LicenseType ?? null : null,
      isProxy: first
        ? first.Proxy === '1' || first.Proxy === 1 || first.Proxy === true
        : false,
      implementation: first ? getString(first, 'Implementation') : null,
      // Avoid returning full SourceCode (token-heavy)
      sourceCodeSize:
        first && typeof first.SourceCode === 'string'
          ? first.SourceCode.length
          : null,
      hasAbiField:
        first && typeof first.ABI === 'string' ? first.ABI.length > 0 : false,
      // Include explorer response status/message if present
      explorerStatus: rawJson ? rawJson.status ?? null : null,
      explorerMessage: rawJson ? rawJson.message ?? null : null,
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
    }
  }
)

server.tool(
  'explorer_get_logs',
  'Query logs via explorer API (module=logs&action=getLogs). Compatibility varies across explorers.',
  {
    fromBlock: z
      .union([z.string(), z.number()])
      .describe('From block (number or "latest").'),
    toBlock: z
      .union([z.string(), z.number()])
      .describe('To block (number or "latest").'),
    address: z
      .string()
      .optional()
      .describe('Optional contract address filter.'),
    topic0: z
      .string()
      .optional()
      .describe('Optional topic0 (event signature hash).'),
    ...baseExplorerArgsSchema,
  },
  async ({
    fromBlock,
    toBlock,
    address,
    topic0,
    network,
    chainId,
    explorerApiUrlOverride,
    apiKeyOverride,
  }: {
    fromBlock: string | number
    toBlock: string | number
    address?: string
    topic0?: string
    network?: string
    chainId?: number
    explorerApiUrlOverride?: string
    apiKeyOverride?: string
  }) => {
    const cfg = resolveExplorerApi({
      network,
      chainId,
      explorerApiUrlOverride,
      apiKeyOverride,
    })
    if (!cfg.ok)
      return {
        content: [{ type: 'text', text: `${cfg.error}\nSee docs/MCP.md.` }],
      }

    const url = buildUrl(cfg.baseUrl, {
      module: 'logs',
      action: 'getLogs',
      fromBlock,
      toBlock,
      address,
      topic0,
      apikey: cfg.apiKey,
    })

    const res = await httpsJson('GET', url)
    return {
      content: [
        {
          type: 'text',
          text:
            `statusCode: ${res.statusCode}\n\n` +
            (res.json ? JSON.stringify(res.json, null, 2) : res.raw),
        },
      ],
    }
  }
)

async function main(): Promise<void> {
  if (isSmokeTest) smokeTest()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('lifi-explorer MCP server running (stdio)') // eslint-disable-line no-console
}

main().catch((err) => {
  console.error('lifi-explorer MCP server error:', err) // eslint-disable-line no-console
  process.exit(1)
})
