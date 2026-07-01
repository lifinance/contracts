/**
 * Move ERC20 token balances from an outgoing wallet to a new wallet across a curated set of
 * networks. Companion to `moveNativeFundsToNewWallet.ts` (which handles native gas) — run this
 * after the native sweep during a staging-wallet rotation. See docs/StagingWalletRotation.md.
 *
 * The token list is human-curated (only tokens worth more than the gas to move them), so the
 * sweep applies no USD threshold: it moves the full balance of every listed token that is > 0.
 *
 * USAGE:
 *   bunx tsx ./script/tasks/moveTokenFundsToNewWallet.ts <newWalletAddress> --tokens <path.json>
 *   bunx tsx ./script/tasks/moveTokenFundsToNewWallet.ts <newWalletAddress> --tokens <path.json> --execute
 *
 * The tokens JSON has shape: { "<network>": ["0xTokenAddress", ...], ... }
 */

import { readFileSync } from 'fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  type Account,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { getEnvVar } from '../utils/utils'
import {
  buildExplorerTxUrl,
  getTransportConfigFromRpcUrl,
  getViemChainForNetworkName,
} from '../utils/viemScriptHelpers'

import {
  ERC20_SWEEP_ABI,
  parseTokenSweepList,
  type ITokenSweepList,
} from './tokenSweepHelpers'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const GREY = '\x1b[90m'
const RESET = '\x1b[0m'

const HTTP_TIMEOUT = 15000 // 15s

/** Derives a viem account from a private key held in the given env var (0x optional). */
function accountFromEnv(envVar: string): Account {
  const key = getEnvVar(envVar).trim().replace(/^0x/, '')
  return privateKeyToAccount(`0x${key}`)
}

/**
 * Sweeps every listed token on a single network from `outgoing` to `newWallet`. Token transfers
 * on the same chain run sequentially so they don't collide on the sender's nonce.
 */
async function sweepNetwork(
  network: string,
  tokens: Address[],
  outgoing: Account,
  newWallet: Address,
  execute: boolean
): Promise<void> {
  const chain = getViemChainForNetworkName(network)
  const rpcUrl = chain.rpcUrls.default.http[0] as string
  const { url, fetchOptions } = getTransportConfigFromRpcUrl(rpcUrl)
  const transport = http(url, { fetchOptions, timeout: HTTP_TIMEOUT })
  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({
    account: outgoing,
    chain,
    transport,
  })

  for (const token of tokens)
    try {
      const [balance, decimals, symbol] = await Promise.all([
        publicClient.readContract({
          address: token,
          abi: ERC20_SWEEP_ABI,
          functionName: 'balanceOf',
          args: [getAddress(outgoing.address)],
        }),
        publicClient.readContract({
          address: token,
          abi: ERC20_SWEEP_ABI,
          functionName: 'decimals',
        }),
        publicClient.readContract({
          address: token,
          abi: ERC20_SWEEP_ABI,
          functionName: 'symbol',
        }),
      ])

      const label = `${network} ${symbol} (${token})`
      if (balance === 0n) {
        consola.log(`${GREY}  skip ${label}: zero balance${RESET}`)
        continue
      }

      const human = formatUnits(balance, decimals)
      if (!execute) {
        consola.log(`  DRY-RUN would move ${human} ${symbol} on ${network}`)
        continue
      }

      const hash = await walletClient.writeContract({
        address: token,
        abi: ERC20_SWEEP_ABI,
        functionName: 'transfer',
        args: [newWallet, balance],
      })
      await publicClient.waitForTransactionReceipt({ hash })
      consola.log(
        `${GREEN}  moved ${human} ${symbol} on ${network} — ${
          buildExplorerTxUrl(network, hash) ?? hash
        }${RESET}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      consola.log(`${RED}  FAILED ${network} ${token}: ${message}${RESET}`)
    }
}

const main = defineCommand({
  meta: {
    name: 'moveTokenFundsToNewWallet',
    description:
      'Sweep curated ERC20 balances from an outgoing wallet to a new wallet',
  },
  args: {
    newWallet: {
      type: 'positional',
      description: 'Address of the new wallet (destination)',
      required: true,
    },
    tokens: {
      type: 'string',
      description:
        'Path to the curated token list JSON { network: [tokenAddress, ...] }',
      required: true,
    },
    'old-key-env': {
      type: 'string',
      description: 'Env var holding the outgoing wallet key',
      default: 'PRIVATE_KEY',
    },
    execute: {
      type: 'boolean',
      description: 'Broadcast transactions (otherwise dry-run)',
      default: false,
    },
  },
  async run({ args }) {
    const newWallet = getAddress(args.newWallet)
    const outgoing = accountFromEnv(args['old-key-env'])
    if (getAddress(outgoing.address) === newWallet) {
      consola.error(
        'Outgoing and new wallet are the same address — nothing to sweep.'
      )
      process.exit(1)
    }

    const list: ITokenSweepList = parseTokenSweepList(
      readFileSync(args.tokens, 'utf8')
    )
    const networks = Object.keys(list)
    consola.info(
      `${args.execute ? 'EXECUTING' : 'DRY-RUN'} ERC20 sweep from ${getAddress(
        outgoing.address
      )} to ${newWallet} across ${networks.length} network(s)`
    )

    await Promise.all(
      networks.map((network) =>
        sweepNetwork(
          network,
          list[network] ?? [],
          outgoing,
          newWallet,
          args.execute
        )
      )
    )
  },
})

runMain(main)
