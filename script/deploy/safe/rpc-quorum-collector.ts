/**
 * Reads one value from every endpoint a network has, for `evaluateRpcQuorum`.
 *
 * Import this from a script that is about to trust a chain read. It turns the
 * endpoints a viem `Chain` carries into the per-provider observations the
 * quorum module grades, so the question "did more than one provider say this"
 * can be asked at sign time rather than assumed.
 *
 * The read is injected: this module decides nothing about what is worth
 * agreeing on, only that whatever was read is read the same way everywhere and
 * at a named block. An observation that cannot say which block it describes is
 * left without one, because two answers are only comparable when they describe
 * the same block and the quorum module grades a blockless answer as a
 * non-response rather than as evidence.
 */

import { createPublicClient, http, type Address } from 'viem'

import { getTransportConfigFromRpcUrl } from '../../utils/viemScriptHelpers'

import type { IProviderObservation } from './rpc-quorum'

/** 8 seconds: a sign-time fan-out must not stall the operator on one slow endpoint. */
const ENDPOINT_TIMEOUT_MS = 8_000

/**
 * One retry per endpoint: viem's default of 3 for most of the fleet, and
 * TronGrid's 8 where the shared transport config carries its profile.
 *
 * The timeout above bounds one attempt, not the call, so a retry profile
 * multiplies it — nine TronGrid attempts on an exponential backoff is minutes
 * of wall clock inside the `Promise.all` a signer is waiting on. A quorum read
 * wants a snapshot of who answers now, and an endpoint needing nine attempts is
 * a non-answer the verdict already grades as one.
 */
const ENDPOINT_RETRY_COUNT = 1

/**
 * 2 seconds between the two attempts, rather than viem's 150 ms default.
 *
 * The retry exists for a throttled endpoint, and 150 ms after a 429 is still
 * inside the window that produced it — a retry that fast is decorative. Two
 * attempts at this spacing cost at most ~2s on top of the timeout, which is the
 * budget the cap above was protecting.
 */
const ENDPOINT_RETRY_DELAY_MS = 2_000

/** One endpoint's answer, before it is graded. */
export interface IEndpointRead {
  /** The value read, compared across providers after trimming. */
  value: string
  blockNumber: bigint
  blockHash: string
}

/** Reads one value from a single named endpoint. */
export type TEndpointReader = (endpointUrl: string) => Promise<IEndpointRead>

/**
 * Reads the same value from every endpoint a network has.
 *
 * Failures are recorded as `error` observations rather than dropped: the quorum
 * module counts providers that were consulted and did not answer separately
 * from providers that were never there, and silently omitting a failing
 * endpoint would shrink the denominator the verdict is measured against.
 *
 * @param endpointUrls - Every endpoint configured for the network, e.g. `chain.rpcUrls.default.http`.
 * @param read - Reads the value from one endpoint.
 * @returns One observation per endpoint, in the order given.
 */
export const collectProviderObservations = async (
  endpointUrls: readonly string[],
  read: TEndpointReader
): Promise<IProviderObservation[]> =>
  Promise.all(
    endpointUrls.map(async (endpointUrl): Promise<IProviderObservation> => {
      try {
        const observed = await read(endpointUrl)
        return {
          endpointUrl,
          outcome: 'ok',
          value: observed.value,
          blockNumber: observed.blockNumber,
          blockHash: observed.blockHash,
        }
      } catch (error) {
        return {
          endpointUrl,
          outcome: 'error',
          // Never rendered as-is by the quorum module, which redacts it: an
          // endpoint URL carrying an API key can appear in a provider's own
          // failure text.
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
  )

/**
 * Names the read a quorum verdict is about, for the operator's line.
 *
 * @param address - The address whose code was read.
 * @param network - The network the read was made on.
 * @returns A label naming what was read and where.
 */
export const codeReadLabel = (address: Address, network: string): string =>
  `code at ${address} on ${network}`

/**
 * Reads the code at one address, at a named block, from a single endpoint.
 *
 * The block is read first and the code is then read *at that block*, so two
 * providers answering at different heights are comparable rather than being
 * silently compared across a reorg boundary.
 *
 * @param address - The address whose code is read.
 * @param chainId - The chain the endpoints serve, so a misrouted endpoint fails loudly.
 * @returns A reader for {@link collectProviderObservations}.
 */
export const createCodeReader =
  (address: Address, chainId: number): TEndpointReader =>
  async (endpointUrl) => {
    // viem's own transport lifts `user:pass@` out of the URL, but its branch is
    // `if (url.username)`: a password-only endpoint keeps its credential in the
    // URL, no header is sent, and the 401 that comes back would be recorded as
    // that provider's answer. The helper also refuses credentials over
    // cleartext http and carries the TronGrid and retry settings.
    const { url, fetchOptions } = getTransportConfigFromRpcUrl(endpointUrl)

    const client = createPublicClient({
      transport: http(url, {
        timeout: ENDPOINT_TIMEOUT_MS,
        retryCount: ENDPOINT_RETRY_COUNT,
        retryDelay: ENDPOINT_RETRY_DELAY_MS,
        ...(fetchOptions ? { fetchOptions } : {}),
      }),
    })

    const observed = await client.getChainId()
    if (observed !== chainId)
      throw new Error(`endpoint reports chain ${observed}, expected ${chainId}`)

    const block = await client.getBlock()
    const code = await client.getCode({ address, blockNumber: block.number })

    return {
      // `'0x'` is the answer, not a default: viem resolves `getCode` to
      // `undefined` for an address that holds no code, and an endpoint that
      // could not answer at all throws and is recorded as an `error`
      // observation instead of reaching this return.
      value: code ?? '0x',
      blockNumber: block.number,
      blockHash: block.hash,
    }
  }
