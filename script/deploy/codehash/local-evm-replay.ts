/**
 * The local EVM `verifyByConstructorReplay` runs a constructor on: a throwaway
 * `anvil`, deployed to and read back over JSON-RPC.
 *
 * Import this only to build the `replay` dependency. A local chain is enough
 * because the deployment is reconstructed rather than re-observed: the args
 * come from `config/`, so there is no archive RPC to reach, no creation block
 * to fork, and no explorer in the path. The node does run as the graded chain,
 * because a constructor may store `block.chainid`.
 */
import { spawn } from 'child_process'

import { createPublicClient, http } from 'viem'
import type { PublicClient } from 'viem'
import { foundry } from 'viem/chains'

import type { IReplayRequest, ReplayOutcome } from './constructor-replay'
import { strip0x } from './hex'

/**
 * Enough for the largest artifact in `src/` with room to spare, and below the
 * 30M block limit anvil rejects a transaction above.
 */
const REPLAY_GAS = 30_000_000n

const STARTUP_PROBES = 100
const STARTUP_PROBE_INTERVAL_MS = 100

export interface ILocalEvmOptions {
  /**
   * Chain the graded deployment lives on. The node reports it as
   * `block.chainid`, so one node grades one chain.
   */
  chainId: number
  /** Port for the throwaway node. Give each concurrent caller its own. */
  port?: number
  /** `anvil` binary, for a caller whose PATH does not carry it. */
  binary?: string
}

export interface ILocalEvm {
  replay: (request: IReplayRequest) => Promise<ReplayOutcome>
  stop: () => void
}

/**
 * Concatenates creation code and the ABI-encoded constructor tail.
 *
 * @param request - Creation code from our own build, and the derived args.
 * @returns The deploy calldata, or why the inputs cannot form any.
 */
export const composeCreationCode = (
  request: Pick<IReplayRequest, 'creationCode' | 'encodedArgs'>
): { ok: true; data: string } | { ok: false; reason: string } => {
  const code = strip0x(request.creationCode)
  if (code.length === 0) return { ok: false, reason: 'creation code is empty' }
  if (code.length % 2 !== 0)
    return { ok: false, reason: 'creation code is not whole bytes' }
  if (!/^[0-9a-fA-F]*$/.test(code))
    return { ok: false, reason: 'creation code is not hex' }

  const args = strip0x(request.encodedArgs)
  if (args.length % 64 !== 0)
    return {
      ok: false,
      reason: 'encoded constructor args are not whole 32-byte words',
    }
  if (!/^[0-9a-fA-F]*$/.test(args))
    return { ok: false, reason: 'encoded constructor args are not hex' }

  return { ok: true, data: `0x${(code + args).toLowerCase()}` }
}

/**
 * @param client - Client pointed at the throwaway node.
 * @param hasFailed - Whether the child has already reported it cannot run, so
 * the probe budget is not spent waiting for a process that will never exist.
 * Checked between probes rather than once up front: `spawn` reports ENOENT
 * asynchronously, so the first probe can precede the failure.
 * @returns Whether the node answered.
 */
const awaitStartup = async (
  client: PublicClient,
  hasFailed: () => boolean
): Promise<boolean> => {
  for (let attempt = 0; attempt < STARTUP_PROBES; attempt++) {
    if (hasFailed()) return false
    try {
      await client.getBlockNumber()
      return true
    } catch {
      await new Promise((resolve) =>
        setTimeout(resolve, STARTUP_PROBE_INTERVAL_MS)
      )
    }
  }
  return false
}

/**
 * Starts a throwaway `anvil` and returns the `replay` dependency plus its stop.
 *
 * The caller owns the lifetime: call `stop` in a `finally`, or the node outlives
 * the process that asked for it.
 *
 * @param options - Chain to run as, plus port and binary overrides.
 * @returns The replay dependency and the handle that shuts the node down.
 */
export const createLocalEvmReplay = (options: ILocalEvmOptions): ILocalEvm => {
  const port = options.port ?? 8599
  const binary = options.binary ?? 'anvil'
  const child = spawn(
    binary,
    ['--silent', '--port', String(port), '--chain-id', String(options.chainId)],
    { stdio: 'ignore' }
  )

  // Without this listener a missing binary escapes as a throw — from the
  // `spawn` call itself under bun, and under Node as an `error` event that
  // terminates the process when nothing is listening. Either shape takes the
  // signer's run down over an optional replay whose whole design is to fall
  // back to masking when it cannot decide. Recorded rather than rethrown, so
  // `replay` can name the cause instead of leaving the caller to infer it from
  // a startup timeout.
  let spawnFailure: string | undefined
  child.on('error', (error) => {
    spawnFailure = `could not start ${binary}: ${error.message}`
  })

  const client = createPublicClient({
    chain: foundry,
    transport: http(`http://127.0.0.1:${port}`),
  }) as PublicClient

  let started: Promise<boolean> | undefined

  const replay = async (request: IReplayRequest): Promise<ReplayOutcome> => {
    const composed = composeCreationCode(request)
    if (!composed.ok) return composed

    started ??= awaitStartup(client, () => spawnFailure !== undefined)
    if (!(await started))
      return {
        ok: false,
        reason: spawnFailure ?? `anvil did not come up on port ${port}`,
      }

    try {
      const running = await client.getChainId()
      if (running !== request.chainId)
        return {
          ok: false,
          reason: `the local EVM runs chain ${running} but the deployment is on chain ${request.chainId}, so a constructor reading block.chainid would be replayed under the wrong one`,
        }

      const accounts = (await client.request({
        method: 'eth_accounts' as never,
        params: [] as never,
      })) as string[]
      const from = accounts[0]
      if (!from)
        return { ok: false, reason: 'anvil offered no unlocked account' }

      const hash = (await client.request({
        method: 'eth_sendTransaction' as never,
        params: [
          { from, data: composed.data, gas: `0x${REPLAY_GAS.toString(16)}` },
        ] as never,
      })) as `0x${string}`

      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success')
        return {
          ok: false,
          reason: 'the constructor reverted on the local EVM',
        }

      const address = receipt.contractAddress
      if (!address)
        return {
          ok: false,
          reason: 'the local EVM reported no created contract',
        }

      const runtimeCode = await client.getCode({ address })
      if (!runtimeCode || strip0x(runtimeCode).length === 0)
        return {
          ok: false,
          reason: 'the constructor returned no runtime code on the local EVM',
        }

      return { ok: true, runtimeCode }
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { replay, stop: () => child.kill() }
}
