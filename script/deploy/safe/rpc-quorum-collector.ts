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

import type { Address } from 'viem'

import type { IProviderObservation } from './rpc-quorum'

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
    endpointUrls.map(
      async (endpointUrl): Promise<IProviderObservation> => {
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
      }
    )
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
