/**
 * Proposes the periphery registrations `deploy-and-register-periphery.ts` finds
 * missing on a Tron diamond.
 */

import type { Address, Hex } from 'viem'
import { encodeFunctionData, parseAbi } from 'viem'

import {
  PairedRegistrationRefusal,
  describeBatch,
  isContractBytecode,
  planRegistrations,
  type IPeripheryRouteConfig,
  type IRegistration,
} from '../../tasks/proposePeripheryWithWhitelist'

const REGISTRY_ABI = parseAbi([
  'function registerPeripheryContract(string,address)',
])

/** A deployed periphery contract the script would register. */
export interface ITronRegistrationCandidate {
  name: string
  /** As the deploy log holds it (base58). */
  address: string
}

/** What the registration pass reads, writes and logs through. */
export interface ITronPeripheryRegistrationDeps {
  network: string
  /** The diamond, as the proposer takes its targets (base58). */
  diamond: string
  /** False off production, where nothing is paired. */
  pairWithWhitelist: boolean
  routeConfig: IPeripheryRouteConfig
  /** Any Tron address form to the 20-byte identity, checksummed. */
  toEvm: (address: string) => Address
  /** The address registered under `name`, or undefined when none is. */
  readRegistered: (name: string) => Promise<Address | undefined>
  /** `getWhitelistedSelectorsForContract(contract)`, as TronWeb returns it. */
  readWhitelistedSelectors: (contract: Address) => Promise<readonly unknown[]>
  hasCode: (address: Address) => Promise<boolean>
  /** One Safe proposal wrapping these calls in a single timelock scheduleBatch. */
  propose: (targets: string[], calldatas: Hex[]) => Promise<void>
  /** Records a proposed registration in the diamond log. */
  recordPending: (name: string, address: string) => Promise<void>
  log: {
    info: (message: string) => void
    warn: (message: string) => void
    error: (message: string) => void
  }
}

/** Which registrations were proposed, and which could not be. */
export interface ITronRegistrationOutcome {
  proposed: string[]
  failed: string[]
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * A `hasCode` read judging Tron bytecode as LibAsset.isContract does.
 *
 * @param readBytecode - The `bytecode` field `trx.getContract` returns for an address.
 * @returns The read.
 */
export function tronHasCode(
  readBytecode: (address: Address) => Promise<unknown>
): (address: Address) => Promise<boolean> {
  return async (address) => {
    const bytecode = await readBytecode(address)
    return typeof bytecode === 'string' && isContractBytecode(bytecode)
  }
}

/**
 * Proposes every candidate that is not already registered at its address: a
 * diamond-called one in its own timelock batch with its allowlist writes,
 * every other one alone.
 *
 * Every candidate's chain state is read, and every batch built, before the
 * first proposal, so a refusal leaves nothing half-proposed. A proposal that
 * fails once built is logged and counted.
 *
 * @param candidates - Deployed contracts, in the order the script deployed them.
 * @param deps - Chain reads, the proposer and the configuration.
 * @returns The names proposed and the names that failed.
 * @throws {PairedRegistrationRefusal} Before anything is proposed, when a
 * registration cannot be read or built.
 */
export async function proposeTronPeripheryRegistrations(
  candidates: readonly ITronRegistrationCandidate[],
  deps: ITronPeripheryRegistrationDeps
): Promise<ITronRegistrationOutcome> {
  const { network, log } = deps
  const outcome: ITronRegistrationOutcome = { proposed: [], failed: [] }
  const pending: (IRegistration & { base58: string })[] = []
  const refusals: string[] = []

  for (const candidate of candidates)
    try {
      const address = deps.toEvm(candidate.address)
      const registered = await deps.readRegistered(candidate.name)
      if (registered?.toLowerCase() === address.toLowerCase()) {
        log.info(`${candidate.name} already correctly registered`)
        continue
      }
      if (registered)
        log.warn(
          `${candidate.name} registered with a different address: ${registered}, new ${address}`
        )
      pending.push({ name: candidate.name, address, base58: candidate.address })
    } catch (error) {
      refusals.push(
        `could not read the registration of ${candidate.name}: ${errorText(
          error
        )}`
      )
    }
  if (refusals.length)
    throw new PairedRegistrationRefusal(
      `[${network}] nothing was proposed:\n  ${refusals.join('\n  ')}`
    )
  if (!pending.length) return outcome

  let plan: Awaited<ReturnType<typeof planRegistrations>>
  try {
    plan = await planRegistrations({
      network,
      diamond: deps.toEvm(deps.diamond),
      registrations: pending,
      routeConfig: deps.routeConfig,
      pair: deps.pairWithWhitelist,
      reader: {
        getPeripheryContract: deps.readRegistered,
        getWhitelistedSelectors: deps.readWhitelistedSelectors,
        hasCode: deps.hasCode,
      },
    })
  } catch (error) {
    if (!(error instanceof PairedRegistrationRefusal)) throw error
    throw new PairedRegistrationRefusal(
      `${error.message}\n[${network}] nothing was proposed`
    )
  }
  const base58 = new Map(pending.map((p) => [p.name, p.base58]))

  for (const registration of plan.plain)
    try {
      const calldata = encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: 'registerPeripheryContract',
        args: [registration.name, registration.address],
      })
      await deps.propose([deps.diamond], [calldata])
      await deps.recordPending(
        registration.name,
        base58.get(registration.name) ?? registration.address
      )
      outcome.proposed.push(registration.name)
    } catch (error) {
      log.error(
        `Failed to propose registration for ${registration.name}: ${errorText(
          error
        )}`
      )
      outcome.failed.push(registration.name)
    }

  for (const batch of plan.paired)
    try {
      log.info(
        `Proposing ${batch.name} with its whitelist writes in one timelock batch`
      )
      for (const line of describeBatch(batch)) log.info(line)
      await deps.propose(
        batch.targets.map(() => deps.diamond),
        batch.calldatas
      )
      await deps.recordPending(
        batch.name,
        base58.get(batch.name) ?? batch.address
      )
      outcome.proposed.push(batch.name)
    } catch (error) {
      log.error(
        `Failed to propose registration for ${batch.name}: ${errorText(error)}`
      )
      outcome.failed.push(batch.name)
    }

  return outcome
}
