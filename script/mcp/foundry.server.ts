import { spawn } from 'node:child_process'
import process from 'node:process'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const isSmokeTest: boolean = process.argv.includes('--smoke-test')

async function run(
  cmd: string,
  args: string[],
  { cwd }: { cwd?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))

    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function smokeTest(): Promise<void> {
  const forge = await run('forge', ['--version'])
  const cast = await run('cast', ['--version'])

  // eslint-disable-next-line no-console
  console.error(
    'foundry smoke test ok\n' +
      `forge: exitCode=${forge.code}\n` +
      `cast: exitCode=${cast.code}\n`
  )

  if (forge.code !== 0 || cast.code !== 0) process.exit(1)
  process.exit(0)
}

const server = new McpServer({
  name: 'lifi-foundry',
  version: '0.1.0',
})

server.tool(
  'forge_build',
  'Run `forge build` (read-only compile).',
  {
    extraArgs: z
      .array(z.string())
      .optional()
      .describe('Extra args appended to forge build.'),
  },
  async ({ extraArgs }: { extraArgs?: string[] }) => {
    const args = ['build', ...(extraArgs ?? [])]
    const { code, stdout, stderr } = await run('forge', args)
    return {
      content: [
        {
          type: 'text',
          text:
            `exitCode: ${code}\n\n` +
            (stdout ? `stdout:\n${stdout}\n\n` : '') +
            (stderr ? `stderr:\n${stderr}\n` : ''),
        },
      ],
    }
  }
)

server.tool(
  'forge_test',
  'Run `forge test` (can be long-running).',
  {
    matchPath: z
      .string()
      .optional()
      .describe(
        "Optional `--match-path` filter, e.g. 'test/solidity/Foo.t.sol'."
      ),
    matchTest: z
      .string()
      .optional()
      .describe('Optional `--match-test` filter (regex).'),
    extraArgs: z
      .array(z.string())
      .optional()
      .describe('Extra args appended to forge test.'),
  },
  async ({
    matchPath,
    matchTest,
    extraArgs,
  }: {
    matchPath?: string
    matchTest?: string
    extraArgs?: string[]
  }) => {
    const args = ['test']
    if (matchPath) args.push('--match-path', matchPath)
    if (matchTest) args.push('--match-test', matchTest)
    args.push(...(extraArgs ?? []))

    const { code, stdout, stderr } = await run('forge', args)
    return {
      content: [
        {
          type: 'text',
          text:
            `exitCode: ${code}\n\n` +
            (stdout ? `stdout:\n${stdout}\n\n` : '') +
            (stderr ? `stderr:\n${stderr}\n` : ''),
        },
      ],
    }
  }
)

server.tool(
  'cast_sig',
  'Compute a function selector (via `cast sig`).',
  {
    signature: z
      .string()
      .describe('Function signature, e.g. "transfer(address,uint256)".'),
  },
  async ({ signature }: { signature: string }) => {
    const { code, stdout, stderr } = await run('cast', ['sig', signature])
    return {
      content: [
        {
          type: 'text',
          text:
            `exitCode: ${code}\n` +
            (stdout ? `stdout: ${stdout}` : '') +
            (stderr ? `\nstderr:\n${stderr}` : ''),
        },
      ],
    }
  }
)

server.tool(
  'cast_4byte',
  'Resolve a 4-byte selector using 4byte.directory (via `cast 4byte`).',
  {
    selectorOrSig: z
      .string()
      .describe('0x12345678 selector or signature string.'),
  },
  async ({ selectorOrSig }: { selectorOrSig: string }) => {
    const { code, stdout, stderr } = await run('cast', ['4byte', selectorOrSig])
    return {
      content: [
        {
          type: 'text',
          text:
            `exitCode: ${code}\n\n` +
            (stdout ? `stdout:\n${stdout}\n\n` : '') +
            (stderr ? `stderr:\n${stderr}\n` : ''),
        },
      ],
    }
  }
)

server.tool(
  'cast_call',
  'Perform an eth_call via `cast call` using `RPC_URL` from env (read-only).',
  {
    to: z.string().describe('Target contract address.'),
    signature: z
      .string()
      .describe('Function signature, e.g. "decimals()(uint8)".'),
    args: z
      .array(z.string())
      .optional()
      .describe('Function arguments as strings, e.g. ["0xabc..."].'),
    block: z
      .string()
      .optional()
      .describe('Optional block tag/number (passed to cast call).'),
    rpcUrlEnvVar: z
      .string()
      .optional()
      .describe('Env var name for RPC URL (default: RPC_URL).'),
  },
  async ({
    to,
    signature,
    args,
    block,
    rpcUrlEnvVar,
  }: {
    to: string
    signature: string
    args?: string[]
    block?: string
    rpcUrlEnvVar?: string
  }) => {
    const envVar = rpcUrlEnvVar ?? 'RPC_URL'
    const rpcUrl = process.env[envVar]
    if (!rpcUrl) {
      return {
        content: [
          {
            type: 'text',
            text: `Missing RPC URL env var: ${envVar}\nSet it in .env.mcp.local (see docs/MCP.md).`,
          },
        ],
      }
    }

    const callArgs = [
      'call',
      '--rpc-url',
      rpcUrl,
      to,
      signature,
      ...(args ?? []),
    ]
    if (block) callArgs.push('--block', block)

    const { code, stdout, stderr } = await run('cast', callArgs)
    return {
      content: [
        {
          type: 'text',
          text:
            `exitCode: ${code}\n\n` +
            (stdout ? `stdout:\n${stdout}\n\n` : '') +
            (stderr ? `stderr:\n${stderr}\n` : ''),
        },
      ],
    }
  }
)

server.tool(
  'cast_tx',
  'Fetch a transaction by hash via `cast tx` using an RPC URL env var (read-only).',
  {
    txHash: z.string().describe('Transaction hash (0x...).'),
    rpcUrlEnvVar: z
      .string()
      .optional()
      .describe('Env var name for RPC URL (default: RPC_URL).'),
    json: z
      .boolean()
      .optional()
      .describe('Whether to pass `--json` (default: false).'),
    extraArgs: z
      .array(z.string())
      .optional()
      .describe('Extra args appended to cast tx.'),
  },
  async ({
    txHash,
    rpcUrlEnvVar,
    json,
    extraArgs,
  }: {
    txHash: string
    rpcUrlEnvVar?: string
    json?: boolean
    extraArgs?: string[]
  }) => {
    const envVar = rpcUrlEnvVar ?? 'RPC_URL'
    const rpcUrl = process.env[envVar]
    if (!rpcUrl) {
      return {
        content: [
          {
            type: 'text',
            text: `Missing RPC URL env var: ${envVar}\nSet it in .env.mcp.local (see docs/MCP.md).`,
          },
        ],
      }
    }

    const callArgs = [
      'tx',
      '--rpc-url',
      rpcUrl,
      ...(json ? ['--json'] : []),
      txHash,
      ...(extraArgs ?? []),
    ]
    const { code, stdout, stderr } = await run('cast', callArgs)
    return {
      content: [
        {
          type: 'text',
          text:
            `exitCode: ${code}\n\n` +
            (stdout ? `stdout:\n${stdout}\n\n` : '') +
            (stderr ? `stderr:\n${stderr}\n` : ''),
        },
      ],
    }
  }
)

server.tool(
  'cast_receipt',
  'Fetch a transaction receipt by hash via `cast receipt` using an RPC URL env var (read-only).',
  {
    txHash: z.string().describe('Transaction hash (0x...).'),
    rpcUrlEnvVar: z
      .string()
      .optional()
      .describe('Env var name for RPC URL (default: RPC_URL).'),
    json: z
      .boolean()
      .optional()
      .describe('Whether to pass `--json` (default: false).'),
    extraArgs: z
      .array(z.string())
      .optional()
      .describe('Extra args appended to cast receipt.'),
  },
  async ({
    txHash,
    rpcUrlEnvVar,
    json,
    extraArgs,
  }: {
    txHash: string
    rpcUrlEnvVar?: string
    json?: boolean
    extraArgs?: string[]
  }) => {
    const envVar = rpcUrlEnvVar ?? 'RPC_URL'
    const rpcUrl = process.env[envVar]
    if (!rpcUrl) {
      return {
        content: [
          {
            type: 'text',
            text: `Missing RPC URL env var: ${envVar}\nSet it in .env.mcp.local (see docs/MCP.md).`,
          },
        ],
      }
    }

    const callArgs = [
      'receipt',
      '--rpc-url',
      rpcUrl,
      ...(json ? ['--json'] : []),
      txHash,
      ...(extraArgs ?? []),
    ]
    const { code, stdout, stderr } = await run('cast', callArgs)
    return {
      content: [
        {
          type: 'text',
          text:
            `exitCode: ${code}\n\n` +
            (stdout ? `stdout:\n${stdout}\n\n` : '') +
            (stderr ? `stderr:\n${stderr}\n` : ''),
        },
      ],
    }
  }
)

async function main(): Promise<void> {
  if (isSmokeTest) await smokeTest()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('lifi-foundry MCP server running (stdio)') // eslint-disable-line no-console
}

main().catch((err) => {
  console.error('lifi-foundry MCP server error:', err) // eslint-disable-line no-console
  process.exit(1)
})
