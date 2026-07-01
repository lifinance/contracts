/**
 * Rotate the owner of every EVM staging LiFiDiamond (the `devWallet` EOA) as part of an
 * SC-dev offboarding. Drives the two-step OwnershipFacet transfer across all staging
 * diamonds and reports progress.
 *
 * Subcommands:
 *   check    read-only — classify each staging diamond as done / pending / not-started
 *   transfer step 1    — outgoing owner calls transferOwnership(incoming)   (dry-run unless --execute)
 *   confirm  step 3    — incoming owner calls confirmOwnershipTransfer()     (dry-run unless --execute)
 *
 * Funds are moved between steps 1 and 3 with the separate sweep scripts
 * (moveNativeFundsToNewWallet.ts, moveTokenFundsToNewWallet.ts) so the incoming wallet has
 * gas to accept. See docs/StagingWalletRotation.md for the full runbook.
 *
 * USAGE:
 *   bunx tsx ./script/tasks/rotateStagingDiamondOwner.ts check
 *   bunx tsx ./script/tasks/rotateStagingDiamondOwner.ts transfer --execute
 *   bunx tsx ./script/tasks/rotateStagingDiamondOwner.ts confirm --execute
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { getEnvVar } from '../utils/utils'
import {
  buildExplorerTxUrl,
  getTransportConfigFromRpcUrl,
  getViemChainForNetworkName,
} from '../utils/viemScriptHelpers'

import {
  classifyOwnershipState,
  getStagingDiamonds,
  OWNERSHIP_FACET_ABI,
  type IStagingDiamond,
  type OwnershipState,
} from './stagingRotationHelpers'

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const GREY = '\x1b[90m'
const RESET = '\x1b[0m'

const HTTP_TIMEOUT = 15000 // 15s — covers slower staging RPCs

const STATE_LABEL: Record<OwnershipState, string> = {
  done: `${GREEN}✅ done${RESET}`,
  pending: `${YELLOW}⏳ pending-accept${RESET}`,
  'not-started': `${RED}❌ not-started${RESET}`,
}

interface IDiamondStatus extends IStagingDiamond {
  owner: Address | null
  state: OwnershipState | null
  error?: string
  txHash?: string
}

/** Derives a viem account from a private key held in the given env var (0x optional). */
function accountFromEnv(envVar: string): Account {
  const key = getEnvVar(envVar).trim().replace(/^0x/, '')
  return privateKeyToAccount(`0x${key}`)
}

/** Builds a public client for a network, applying RPC auth/Tron transport extras. */
function publicClientFor(network: string): {
  chain: Chain
  client: PublicClient
} {
  const chain = getViemChainForNetworkName(network)
  const rpcUrl = chain.rpcUrls.default.http[0] as string
  const { url, fetchOptions, retryCount, retryDelay } =
    getTransportConfigFromRpcUrl(rpcUrl)
  const client = createPublicClient({
    chain,
    transport: http(url, {
      fetchOptions,
      timeout: HTTP_TIMEOUT,
      retryCount,
      retryDelay,
    }),
  }) as PublicClient
  return { chain, client }
}

/**
 * Reads a staging diamond's owner and classifies its transfer state. The pending-owner
 * getter is private on OwnershipFacet, so the pending state is detected by simulating
 * `confirmOwnershipTransfer` from the incoming owner (a read-only eth_call).
 */
async function readStatus(
  entry: IStagingDiamond,
  incomingOwner: Address
): Promise<IDiamondStatus> {
  try {
    const { client } = publicClientFor(entry.network)
    const owner = (await client.readContract({
      address: entry.diamond,
      abi: OWNERSHIP_FACET_ABI,
      functionName: 'owner',
    })) as Address

    let confirmWouldSucceed = false
    if (getAddress(owner) !== getAddress(incomingOwner))
      try {
        await client.simulateContract({
          address: entry.diamond,
          abi: OWNERSHIP_FACET_ABI,
          functionName: 'confirmOwnershipTransfer',
          account: incomingOwner,
        })
        confirmWouldSucceed = true
      } catch {
        // Revert (NotPendingOwner) ⇒ incoming wallet is not the pending owner. owner()
        // already succeeded, so this is a contract revert rather than an RPC failure.
        confirmWouldSucceed = false
      }

    return {
      ...entry,
      owner: getAddress(owner),
      state: classifyOwnershipState(owner, incomingOwner, confirmWouldSucceed),
    }
  } catch (error) {
    return {
      ...entry,
      owner: null,
      state: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function printStatusTable(results: IDiamondStatus[]): void {
  const width = Math.max(
    ...results.map((r) => r.network.length),
    'Network'.length
  )
  consola.log('')
  for (const r of results) {
    const label = r.error
      ? `${GREY}❓ ${r.error.slice(0, 60)}${RESET}`
      : STATE_LABEL[r.state as OwnershipState]
    consola.log(`  ${r.network.padEnd(width)}  ${label}`)
  }
  consola.log('')
}

/** Resolves the incoming owner address: explicit --new-owner, else derived from the env key. */
function resolveIncomingOwner(
  newOwner: string | undefined,
  newKeyEnv: string
): Address {
  if (newOwner) return getAddress(newOwner)
  return getAddress(accountFromEnv(newKeyEnv).address)
}

const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Report staging diamond ownership state per network',
  },
  args: {
    'new-owner': {
      type: 'string',
      description:
        'Incoming owner address (defaults to address derived from --new-key-env)',
    },
    'new-key-env': {
      type: 'string',
      description: 'Env var holding the incoming wallet key',
      default: 'PRIVATE_KEY_NEW',
    },
  },
  async run({ args }) {
    const incomingOwner = resolveIncomingOwner(
      args['new-owner'],
      args['new-key-env']
    )
    const diamonds = await getStagingDiamonds()
    consola.info(
      `Checking ${diamonds.length} staging diamonds; expected incoming owner: ${incomingOwner}`
    )

    const results = await Promise.all(
      diamonds.map((entry) => readStatus(entry, incomingOwner))
    )
    printStatusTable(results)

    const done = results.filter((r) => r.state === 'done').length
    const pending = results.filter((r) => r.state === 'pending').length
    const notStarted = results.filter((r) => r.state === 'not-started').length
    const errored = results.filter((r) => r.error).length
    consola.info(
      `done: ${done} | pending-accept: ${pending} | not-started: ${notStarted} | errors: ${errored}`
    )

    if (done !== results.length) process.exit(1)
  },
})

const transferCommand = defineCommand({
  meta: {
    name: 'transfer',
    description:
      'Step 1: outgoing owner initiates transferOwnership to the incoming owner',
  },
  args: {
    execute: {
      type: 'boolean',
      description: 'Broadcast transactions (otherwise dry-run)',
      default: false,
    },
    'old-key-env': {
      type: 'string',
      description: 'Env var holding the outgoing wallet key',
      default: 'PRIVATE_KEY',
    },
    'new-owner': {
      type: 'string',
      description:
        'Incoming owner address (defaults to address from --new-key-env)',
    },
    'new-key-env': {
      type: 'string',
      description: 'Env var holding the incoming wallet key',
      default: 'PRIVATE_KEY_NEW',
    },
  },
  async run({ args }) {
    const outgoing = accountFromEnv(args['old-key-env'])
    const incomingOwner = resolveIncomingOwner(
      args['new-owner'],
      args['new-key-env']
    )
    if (getAddress(outgoing.address) === incomingOwner) {
      consola.error(
        'Outgoing and incoming owner are the same address — nothing to transfer.'
      )
      process.exit(1)
    }

    const diamonds = await getStagingDiamonds()
    const statuses = await Promise.all(
      diamonds.map((entry) => readStatus(entry, incomingOwner))
    )

    consola.info(
      `${
        args.execute ? 'EXECUTING' : 'DRY-RUN'
      } transferOwnership(${incomingOwner}) from ${getAddress(
        outgoing.address
      )}`
    )

    const results = await Promise.all(
      statuses.map((status) =>
        runTransfer(status, outgoing, incomingOwner, args.execute)
      )
    )
    printStatusTable(results)
    if (results.some((r) => r.error)) process.exit(1)
  },
})

async function runTransfer(
  status: IDiamondStatus,
  outgoing: Account,
  incomingOwner: Address,
  execute: boolean
): Promise<IDiamondStatus> {
  if (status.state === 'done' || status.state === 'pending') return status // already transferred or awaiting accept — idempotent skip
  if (status.error) return status
  if (status.owner && getAddress(status.owner) !== getAddress(outgoing.address))
    return {
      ...status,
      error: `owner is ${status.owner}, not the outgoing wallet`,
    }

  if (!execute) return { ...status, state: 'not-started' }

  try {
    const { chain, client } = publicClientFor(status.network)
    const walletClient = createWalletClient({
      account: outgoing,
      chain,
      transport: http(chain.rpcUrls.default.http[0], { timeout: HTTP_TIMEOUT }),
    })
    const hash = await walletClient.writeContract({
      address: status.diamond,
      abi: OWNERSHIP_FACET_ABI,
      functionName: 'transferOwnership',
      args: [incomingOwner],
    })
    await client.waitForTransactionReceipt({ hash })
    consola.success(
      `${status.network}: transfer initiated — ${
        buildExplorerTxUrl(status.network, hash) ?? hash
      }`
    )
    return { ...status, state: 'pending', txHash: hash }
  } catch (error) {
    return {
      ...status,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const confirmCommand = defineCommand({
  meta: {
    name: 'confirm',
    description:
      'Step 3: incoming owner accepts ownership (confirmOwnershipTransfer)',
  },
  args: {
    execute: {
      type: 'boolean',
      description: 'Broadcast transactions (otherwise dry-run)',
      default: false,
    },
    'new-key-env': {
      type: 'string',
      description: 'Env var holding the incoming wallet key',
      default: 'PRIVATE_KEY_NEW',
    },
  },
  async run({ args }) {
    const incoming = accountFromEnv(args['new-key-env'])
    const incomingOwner = getAddress(incoming.address)

    const diamonds = await getStagingDiamonds()
    const statuses = await Promise.all(
      diamonds.map((entry) => readStatus(entry, incomingOwner))
    )

    consola.info(
      `${
        args.execute ? 'EXECUTING' : 'DRY-RUN'
      } confirmOwnershipTransfer() as ${incomingOwner}`
    )

    const results = await Promise.all(
      statuses.map((status) => runConfirm(status, incoming, args.execute))
    )
    printStatusTable(results)
    if (results.some((r) => r.error)) process.exit(1)
  },
})

async function runConfirm(
  status: IDiamondStatus,
  incoming: Account,
  execute: boolean
): Promise<IDiamondStatus> {
  if (status.state === 'done') return status
  if (status.error) return status
  if (status.state !== 'pending')
    return { ...status, error: 'not pending — run transfer first' }

  if (!execute) return status

  try {
    const { chain, client } = publicClientFor(status.network)
    const walletClient = createWalletClient({
      account: incoming,
      chain,
      transport: http(chain.rpcUrls.default.http[0], { timeout: HTTP_TIMEOUT }),
    })
    const hash = await walletClient.writeContract({
      address: status.diamond,
      abi: OWNERSHIP_FACET_ABI,
      functionName: 'confirmOwnershipTransfer',
    })
    await client.waitForTransactionReceipt({ hash })
    consola.success(
      `${status.network}: ownership accepted — ${
        buildExplorerTxUrl(status.network, hash) ?? hash
      }`
    )
    return { ...status, state: 'done', txHash: hash }
  } catch (error) {
    return {
      ...status,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const main = defineCommand({
  meta: {
    name: 'rotateStagingDiamondOwner',
    description:
      'Rotate the owner of all EVM staging LiFiDiamonds during SC-dev offboarding',
  },
  subCommands: {
    check: checkCommand,
    transfer: transferCommand,
    confirm: confirmCommand,
  },
})

runMain(main)
