/**
 * Proposes the periphery registrations `deploy-and-register-periphery.ts` finds
 * missing on a Tron diamond. A diamond-called contract's registration travels in
 * one timelock batch with the whitelist writes; every other name keeps its own
 * registration proposal. The chain and the proposer are injected by the caller.
 */

import type { Address, Hex } from 'viem'
import { encodeFunctionData, parseAbi } from 'viem'

import {
  assertWhitelistListsRegistrations,
  buildPairedRegistrationBatch,
  desiredPairs,
  diffPairs,
  peripheryRegistrationRoute,
  requiredSelectorsFor,
  type IPair,
  type IPairedRegistration,
  type IPairedRegistrationBatch,
  type IPeripheryRouteConfig,
  type IWhitelistConfig,
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
  /** False where `config/whitelist.json` does not describe the network (staging). */
  pairWithWhitelist: boolean
  routeConfig: IPeripheryRouteConfig
  whitelistConfig: IWhitelistConfig
  /** Any Tron address form to the 20-byte identity, checksummed. */
  toEvm: (address: string) => Address
  /** The address registered under `name`, or undefined when none is. */
  readRegistered: (name: string) => Promise<Address | undefined>
  /** Every (contract, selector) pair the diamond allowlists now. */
  readActualPairs: () => Promise<IPair[]>
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
 * Proposes every candidate that is not already registered at its address.
 *
 * Routes are decided, and `config/whitelist.json` checked, for every candidate
 * before the first proposal, so a refusal leaves nothing half-proposed. A
 * failed read or proposal of one plain registration is logged and counted, as
 * the script always did.
 *
 * @param candidates - Deployed contracts, in the order the script deployed them.
 * @param deps - Chain reads, the proposer and the configuration.
 * @returns The names proposed and the names that failed.
 * @throws When `config/whitelist.json` does not cover a paired registration, or
 * the paired batch cannot be built — before anything is proposed in the first case.
 */
export async function proposeTronPeripheryRegistrations(
  candidates: readonly ITronRegistrationCandidate[],
  deps: ITronPeripheryRegistrationDeps
): Promise<ITronRegistrationOutcome> {
  const { network, log } = deps
  const outcome: ITronRegistrationOutcome = { proposed: [], failed: [] }
  const plain: ITronRegistrationCandidate[] = []
  const paired: {
    candidate: ITronRegistrationCandidate
    registration: IPairedRegistration
  }[] = []

  for (const candidate of candidates) {
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

      const route = deps.pairWithWhitelist
        ? peripheryRegistrationRoute(candidate.name, network, deps.routeConfig)
        : 'not-diamond-called'
      if (route === 'paired')
        paired.push({
          candidate,
          registration: {
            name: candidate.name,
            address,
            required: requiredSelectorsFor(candidate.name, deps.routeConfig),
          },
        })
      else plain.push(candidate)
    } catch (error) {
      log.error(
        `Failed to read the registration of ${candidate.name}: ${errorText(
          error
        )}`
      )
      outcome.failed.push(candidate.name)
    }
  }

  const registrations = paired.map((p) => p.registration)
  const batch = registrations.length
    ? await buildTronPairedBatch(registrations, deps)
    : undefined

  for (const candidate of plain)
    try {
      const calldata = encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: 'registerPeripheryContract',
        args: [candidate.name, deps.toEvm(candidate.address)],
      })
      await deps.propose([deps.diamond], [calldata])
      await deps.recordPending(candidate.name, candidate.address)
      outcome.proposed.push(candidate.name)
    } catch (error) {
      log.error(
        `Failed to propose registration for ${candidate.name}: ${errorText(
          error
        )}`
      )
      outcome.failed.push(candidate.name)
    }

  if (!batch) return outcome

  log.info(
    `Proposing ${registrations
      .map((r) => r.name)
      .join(', ')} with the whitelist writes in one timelock batch (remove=${
      batch.toRemove.length
    }, add=${batch.toAdd.length})`
  )
  for (const p of batch.toRemove) log.info(`  - ${p.contract} ${p.selector}`)
  for (const p of batch.toAdd) log.info(`  + ${p.contract} ${p.selector}`)

  await deps.propose(
    batch.targets.map(() => deps.diamond),
    batch.calldatas
  )
  for (const { candidate } of paired) {
    await deps.recordPending(candidate.name, candidate.address)
    outcome.proposed.push(candidate.name)
  }
  return outcome
}

/**
 * Reads the diamond's allowlist and builds the paired batch, so every refusal
 * lands before the caller proposes anything.
 */
async function buildTronPairedBatch(
  registrations: IPairedRegistration[],
  deps: ITronPeripheryRegistrationDeps
): Promise<IPairedRegistrationBatch> {
  const { network } = deps
  const desired = desiredPairs(deps.whitelistConfig, network, deps.toEvm)
  assertWhitelistListsRegistrations(desired, registrations, network)

  const actual = await deps.readActualPairs()
  const toCheck = [
    ...new Set([
      ...registrations.map((r) => r.address),
      ...diffPairs(desired, actual).toAdd.map((p) => p.contract),
    ]),
  ]
  const codeless = new Set<string>()
  for (const address of toCheck)
    if (!(await deps.hasCode(address))) codeless.add(address.toLowerCase())

  const batch = buildPairedRegistrationBatch({
    network,
    diamond: deps.toEvm(deps.diamond),
    registrations,
    desired,
    actual,
    codeless,
  })
  if (batch.skippedCodeless.length)
    deps.log.warn(
      `skipping ${
        batch.skippedCodeless.length
      } whitelist target(s) with no on-chain code: ${batch.skippedCodeless.join(
        ', '
      )} — fix config/whitelist.json`
    )
  return batch
}
