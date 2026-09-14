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

/**
 * 20 seconds for everything one endpoint is asked, not for one round trip.
 *
 * A sign-time fan-out must not stall the operator on one slow endpoint, and
 * this reader makes three round trips per endpoint — `getChainId`, `getBlock`,
 * `getCode`. A per-attempt timeout bounds each of those separately, so the
 * three multiply and the retry profile multiplies again; the budget is
 * therefore carried on one `AbortSignal` per endpoint instead, which viem
 * honours for the whole read and does not retry past.
 *
 * Generous for a single round trip, deliberately: a slow-but-honest endpoint
 * dropped from the fan-out costs a provider the verdict counts, and below
 * `MIN_INDEPENDENT_PROVIDERS` that turns agreement into a refusal to sign.
 */
const ENDPOINT_READ_BUDGET_MS = 20_000

/**
 * One retry per endpoint: viem's default of 3 for most of the fleet, and
 * TronGrid's 8 where the shared transport config carries its profile.
 *
 * A quorum read wants a snapshot of who answers now, and an endpoint needing
 * nine attempts is a non-answer the verdict already grades as one. The budget
 * above is the hard bound; this keeps a single 429 from spending it.
 */
const ENDPOINT_RETRY_COUNT = 1

/**
 * 2 seconds between the two attempts, rather than viem's 150 ms default.
 *
 * The retry exists for a throttled endpoint, and 150 ms after a 429 is still
 * inside the window that produced it — a retry that fast is decorative. The
 * wait is spent inside the budget above, not on top of it.
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
 * @param budgetMs - The whole-read budget; lowered by tests, which cannot wait out the default.
 * @returns A reader for {@link collectProviderObservations}.
 */
export const createCodeReader =
  (
    address: Address,
    chainId: number,
    budgetMs: number = ENDPOINT_READ_BUDGET_MS
  ): TEndpointReader =>
  async (endpointUrl) => {
    // viem's own transport lifts `user:pass@` out of the URL, but its branch is
    // `if (url.username)`: a password-only endpoint keeps its credential in the
    // URL, no header is sent, and the 401 that comes back would be recorded as
    // that provider's answer. The helper also refuses credentials over
    // cleartext http.
    //
    // The raw helper rather than `getSignTimeTransportConfig`: this is a
    // fan-out over every endpoint a network has, so it can be tighter than a
    // single-endpoint sign-time read — a slow endpoint here costs one
    // observation the verdict already grades, not the answer.
    const { url, fetchOptions } = getTransportConfigFromRpcUrl(endpointUrl)

    // One signal for the three round trips below, so the budget bounds the read
    // rather than each attempt within it — viem passes a supplied
    // `fetchOptions.signal` straight to the request in place of its own
    // per-attempt one. Merged into `fetchOptions`, never replacing it: that
    // object carries the endpoint's credential and API-key headers.
    //
    // Not `AbortSignal.timeout`, which aborts with a `TimeoutError`: viem's
    // `isAbortError` matches `AbortError` alone, so a timeout abort is retried
    // and the read outlives the budget by a retry delay. Aborting with that
    // name is what makes the budget a bound rather than a first estimate.
    const controller = new AbortController()
    const budget = setTimeout(
      () =>
        controller.abort(
          new DOMException(`no answer within ${budgetMs}ms`, 'AbortError')
        ),
      budgetMs
    )

    try {
      const client = createPublicClient({
        transport: http(url, {
          timeout: budgetMs,
          retryCount: ENDPOINT_RETRY_COUNT,
          retryDelay: ENDPOINT_RETRY_DELAY_MS,
          fetchOptions: { ...fetchOptions, signal: controller.signal },
        }),
      })

      const observed = await client.getChainId()
      if (observed !== chainId)
        throw new Error(
          `endpoint reports chain ${observed}, expected ${chainId}`
        )

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
    } finally {
      // A pending timer keeps the process alive after the fan-out has its
      // answer, which on a CLI is a run that will not exit.
      clearTimeout(budget)
    }
  }
