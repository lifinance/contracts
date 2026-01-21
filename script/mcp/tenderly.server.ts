import https from 'node:https'
import process from 'node:process'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const isSmokeTest: boolean = process.argv.includes('--smoke-test')

interface IHttpJsonResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  raw: string
  json: unknown
}

function httpsJson(
  method: string,
  url: string,
  {
    headers = {},
    body,
  }: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<IHttpJsonResponse> {
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
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
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
          resolve({ statusCode, headers: res.headers, raw, json: parsed })
        })
      }
    )
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

type TenderlyConfig =
  | { ok: true; accessKey: string; account: string; project: string }
  | { ok: false; error: string }

function getTenderlyConfig(): TenderlyConfig {
  const accessKey = process.env.TENDERLY_ACCESS_KEY
  const account = process.env.TENDERLY_ACCOUNT
  const project = process.env.TENDERLY_PROJECT

  if (!accessKey || !account || !project) {
    return {
      ok: false,
      error:
        'Missing one of: TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT',
    }
  }

  return { ok: true, accessKey, account, project }
}

function smokeTest(): void {
  const cfg = getTenderlyConfig()
  if (!cfg.ok) {
    // eslint-disable-next-line no-console
    console.error(`tenderly smoke test failed: ${cfg.error}`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.error('tenderly smoke test ok')
  process.exit(0)
}

const server = new McpServer({
  name: 'lifi-tenderly',
  version: '0.1.0',
})

type UnknownRecord = Record<string, unknown>

function isRecord(v: unknown): v is UnknownRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function getRecord(obj: UnknownRecord, key: string): UnknownRecord | null {
  const v = obj[key]
  return isRecord(v) ? v : null
}

function getString(obj: UnknownRecord, key: string): string | null {
  const v = obj[key]
  return typeof v === 'string' ? v : null
}

function getNumber(obj: UnknownRecord, key: string): number | null {
  const v = obj[key]
  return typeof v === 'number' ? v : null
}

function asHexSelector(input: unknown): string | null {
  if (typeof input !== 'string') return null
  if (!input.startsWith('0x')) return null
  return input.length >= 10 ? input.slice(0, 10) : input
}

function collectCallTraceNodes(
  roots: unknown,
  { maxNodes }: { maxNodes: number }
): Array<{
  depth: number
  from?: string | null
  to?: string | null
  selector?: string | null
  method?: string | null
  value?: string | null
  gasUsed?: string | number | null
  error?: string | null
}> {
  const out: Array<{
    depth: number
    from?: string | null
    to?: string | null
    selector?: string | null
    method?: string | null
    value?: string | null
    gasUsed?: string | number | null
    error?: string | null
  }> = []

  const stack: Array<{ node: unknown; depth: number }> = []
  const arr = Array.isArray(roots) ? roots : roots ? [roots] : []
  for (let i = arr.length - 1; i >= 0; i--)
    stack.push({ node: arr[i], depth: 0 })

  while (stack.length > 0 && out.length < maxNodes) {
    const popped = stack.pop()
    if (!popped) break
    const { node, depth } = popped
    if (!isRecord(node)) continue

    const decoded =
      getRecord(node, 'decoded_input') ??
      getRecord(node, 'decodedInput') ??
      null
    const decodedMethod = decoded ? getString(decoded, 'method') : null
    const method = decodedMethod ?? getString(node, 'method')

    out.push({
      depth,
      from: getString(node, 'from'),
      to: getString(node, 'to'),
      selector: asHexSelector(node.input),
      method,
      value: getString(node, 'value'),
      gasUsed:
        getNumber(node, 'gas_used') ?? getNumber(node, 'gasUsed') ?? null,
      error: getString(node, 'error'),
    })

    const children = node.calls ?? node.children ?? node.call_trace ?? null
    if (Array.isArray(children) && children.length > 0) {
      for (let i = children.length - 1; i >= 0; i--)
        stack.push({ node: children[i], depth: depth + 1 })
    }
  }

  return out
}

server.tool(
  'tenderly_simulate',
  'Simulate a transaction via Tenderly (no signing, no broadcast).',
  {
    networkId: z
      .union([z.string(), z.number()])
      .describe('Tenderly network id (e.g. 1 for Ethereum).'),
    from: z.string().describe('From address (EOA or contract).'),
    to: z.string().describe('To address (contract).'),
    data: z.string().describe('Calldata (0x...).'),
    value: z
      .string()
      .optional()
      .describe('Value in wei as decimal string or 0x hex (default: 0).'),
    gas: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Optional gas limit.'),
    blockNumber: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Optional block number.'),
    save: z
      .boolean()
      .optional()
      .describe('Whether to save simulation in Tenderly (default: false).'),
    compact: z
      .boolean()
      .optional()
      .describe(
        'If true, return a compact, token-efficient summary plus a capped call trace (default: true).'
      ),
    maxCallTraceNodes: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'Max call trace nodes to return when compact=true (default: 200).'
      ),
  },
  async ({
    networkId,
    from,
    to,
    data,
    value,
    gas,
    blockNumber,
    save,
    compact,
    maxCallTraceNodes,
  }: {
    networkId: string | number
    from: string
    to: string
    data: string
    value?: string
    gas?: string | number
    blockNumber?: string | number
    save?: boolean
    compact?: boolean
    maxCallTraceNodes?: string | number
  }) => {
    const cfg = getTenderlyConfig()
    if (!cfg.ok) {
      return {
        content: [
          {
            type: 'text',
            text: `${cfg.error}\nSet these in .env.mcp.local (see docs/MCP.md).`,
          },
        ],
      }
    }

    const url = `https://api.tenderly.co/api/v1/account/${encodeURIComponent(
      cfg.account
    )}/project/${encodeURIComponent(cfg.project)}/simulate`

    const body = {
      save: Boolean(save),
      save_if_fails: false,
      simulation_type: 'quick',
      network_id: String(networkId),
      from,
      to,
      input: data,
      value: value ?? '0',
      ...(gas !== undefined ? { gas: String(gas) } : {}),
      ...(blockNumber !== undefined
        ? { block_number: String(blockNumber) }
        : {}),
    }

    const res = await httpsJson('POST', url, {
      headers: {
        'x-access-key': cfg.accessKey,
      },
      body,
    })

    const wantCompact = compact !== false
    const maxNodes = Math.max(
      0,
      Math.min(2000, Number(maxCallTraceNodes ?? 200))
    )

    if (wantCompact && isRecord(res.json)) {
      const j = res.json

      const tx = getRecord(j, 'transaction') ?? {}
      const info =
        getRecord(j, 'transaction_info') ??
        getRecord(j, 'transactionInfo') ??
        {}
      const callTrace = info.call_trace ?? info.callTrace ?? null

      const compactOut = {
        statusCode: res.statusCode,
        networkId: String(networkId),
        from,
        to,
        selector: asHexSelector(data),
        // High-signal failure/success fields (Tenderly usually returns these)
        status: tx.status ?? null,
        gasUsed: tx.gas_used ?? tx.gasUsed ?? null,
        errorMessage: tx.error_message ?? tx.errorMessage ?? null,
        revertReason: tx.revert_reason ?? tx.revertReason ?? null,
        // Optional metadata (keep small)
        blockNumber:
          info.block_number ?? info.blockNumber ?? blockNumber ?? null,
        method: typeof info.method === 'string' ? info.method : null,
        // Capped trace
        callTrace: collectCallTraceNodes(callTrace, { maxNodes }),
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(compactOut, null, 2),
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `statusCode: ${res.statusCode}\n\n` +
            (res.json
              ? JSON.stringify(res.json, null, 2)
              : res.raw || '(empty response)'),
        },
      ],
    }
  }
)

async function main(): Promise<void> {
  if (isSmokeTest) smokeTest()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('lifi-tenderly MCP server running (stdio)') // eslint-disable-line no-console
}

main().catch((err) => {
  console.error('lifi-tenderly MCP server error:', err) // eslint-disable-line no-console
  process.exit(1)
})
