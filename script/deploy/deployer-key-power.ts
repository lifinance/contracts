/**
 * R7.1 — the deployer key's power inventory, and the config assertion that bounds it.
 *
 * The walk compares address *strings*, so the Tron identity is matched as base58 and the EVM
 * identity as hex — including the `41`-prefixed TronWeb hex form, which is a pure string
 * transform of the EVM address. Both are the same key today (`tronWallets.deployerWallet`
 * decodes to `deployerWallet`), but a base58 re-encoding of the EVM identity would not match:
 * decoding needs a TronWeb instance, which the dependency-light `bun test:ts` job deliberately
 * does not carry.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import globalConfigJson from '../../config/global.json'
import networksConfigJson from '../../config/networks.json'

import { SAFE_THRESHOLD } from './shared/constants'

/** What holding the key buys an attacker who holds nothing else. */
export type TDeployerPowerClass =
  /** Changes nothing beyond cost and liveness. */
  | 'no-authority'
  /** Can degrade liveness or grief, recoverably. */
  | 'dos'
  /** Produces a value a downstream gate must re-derive rather than trust. */
  | 'untrusted-input'
  /** Can change which code executes, or who governs it, without a Safe threshold. */
  | 'integrity'

/** Where the power applies. Only `production-mainnet` carries the R7.1 bound. */
export type TDeployerPowerScope =
  | 'production-mainnet'
  | 'production-bring-up'
  | 'non-production'

export interface IDeployerPower {
  id: string
  power: string
  /** The code path that exercises it. */
  surface: string
  class: TDeployerPowerClass
  scope: TDeployerPowerScope
  /** `pending` powers are not held yet; the ticket that grants them is named in `note`. */
  status: 'current' | 'pending'
  note: string
}

export const DEPLOYER_KEY_POWERS: readonly IDeployerPower[] = [
  {
    id: 'deploy',
    power: 'Deploy arbitrary bytecode (CREATE3, every network)',
    surface:
      'script/deploy/deploySingleContract.sh (getPrivateKey … production)',
    class: 'no-authority',
    scope: 'production-mainnet',
    status: 'current',
    note: 'Deployed code is inert until a diamondCut wires it, and the cut needs the Safe threshold.',
  },
  {
    id: 'record',
    power: 'Write the deployment record at deploy time',
    surface: 'script/deploy/update-deployment-logs.ts add (Mongo upsert)',
    class: 'untrusted-input',
    scope: 'production-mainnet',
    status: 'current',
    note: 'A lying record is the G7 threat model; the sign-time codehash gate re-derives instead of trusting it.',
  },
  {
    id: 'propose',
    power: 'Create a Safe proposal',
    surface: 'script/deploy/safe/propose-to-safe.ts (runPropose)',
    class: 'dos',
    scope: 'production-mainnet',
    status: 'current',
    note: 'A proposal claims a nonce and is otherwise inert; an unsigned proposal is discardable.',
  },
  {
    id: 'one-signature',
    power: 'Contribute one Safe signature',
    surface: 'config/global.json safeOwners — the deployer is one owner',
    class: 'dos',
    scope: 'production-mainnet',
    status: 'current',
    note: 'One of a threshold of several. Bounded by assertDeployerKeyPowerBounded, not by convention.',
  },
  {
    id: 'cancel',
    power: 'Cancel a queued timelock operation',
    surface:
      'CANCELLER_ROLE, granted to the _cancellerWallet constructor arg in src/Security/LiFiTimelockController.sol',
    class: 'dos',
    scope: 'production-mainnet',
    status: 'current',
    note: 'T6 accepts this: a cancel costs a re-proposal, never a wrong operation. Holder set is mutable on-chain, so read it there.',
  },
  {
    id: 'broadcast-safe-execution',
    power: 'Broadcast a Safe execution once the threshold is met',
    surface:
      'the "…With Deployer" execute variants in script/deploy/safe/confirm-safe-tx.ts',
    class: 'no-authority',
    scope: 'production-mainnet',
    status: 'current',
    note: 'Carries signatures it did not produce; withholding the broadcast is DoS, not an integrity break.',
  },
  {
    id: 'timelock-execute',
    power: 'Execute a ready timelock operation as the sole executor',
    surface: 'EXECUTOR_ROLE on LiFiTimelockController',
    class: 'dos',
    scope: 'production-mainnet',
    status: 'pending',
    note: 'Granted only once the F7 executor restriction lands (WP-6.2 / EXSC-872). On main EXECUTOR_ROLE is still address(0) — execution is permissionless and the deployer holds no executor grant.',
  },
  {
    id: 'safe-deployment',
    power:
      'Deploy the governance Safe with an owner set and threshold of its choosing, then repoint config at it',
    surface:
      'script/deploy/safe/deploy-safe.ts — --owners is unioned into globalConfig.safeOwners, --threshold accepts any value >= 1, allowOverride defaults to true so the "Safe already deployed" guard does not fire, and config/networks.json safeAddress is rewritten with the result; script/deploy/tron/deploy-safe-tron.ts is the Tron equivalent',
    class: 'integrity',
    scope: 'production-mainnet',
    status: 'current',
    note: 'The script\'s own on-chain verification compares getOwners() and getThreshold() against the same expanded owners array and threshold it was passed, so it confirms "deployed as asked", not "as configured". Abuse is observable, not prevented — see ACKNOWLEDGED_PRODUCTION_INTEGRITY_POWERS.',
  },
  {
    id: 'testnet-diamond-owner',
    power: 'Own the diamond outright (diamondCut without a Safe)',
    surface:
      "healthCheckInvariants.ts 'diamond-owner' asserts ctx.deployerWallet owns the diamond on testnets; deployAllContracts.sh stage 12 skips the timelock transfer there",
    class: 'integrity',
    scope: 'non-production',
    status: 'current',
    note: 'Testnet diamonds have no Safe or timelock by design, so the R7.1 bound is a production-mainnet claim and is scoped as such. Staging on a mainnet network is a different key: helperFunctions.sh getPrivateKey returns PRIVATE_KEY there, and healthCheck.ts resolves ctx.deployerWallet to globalConfig.devWallet.',
  },
  {
    id: 'bring-up-diamond-owner',
    power: 'Own a production diamond until the timelock transfer is confirmed',
    surface:
      'deployAllContracts.sh stage 12 — transferOwnership(timelock) is sent from the deployer as the then-current owner; confirmOwnershipTransfer() is proposed to the Safe',
    class: 'integrity',
    scope: 'production-bring-up',
    status: 'current',
    note: 'Closes when the Safe executes the confirmation. A network left in this state is reported unhealthy by the diamond-owner invariant.',
  },
] as const

/**
 * Production-mainnet integrity powers that are disclosed rather than refused, mapped to the check
 * that makes abuse observable. An unlisted id refuses, so a power promoted into this class cannot
 * reach main by editing its own row; and a disclosure with nothing watching it is not a
 * disclosure, which is why the value is required to be non-empty.
 *
 * Detection is weaker than removal, so each value names the work that retires the entry. An empty
 * map is the target state: R7.1's bound is only fully held when this map is empty.
 */
export const ACKNOWLEDGED_PRODUCTION_INTEGRITY_POWERS: ReadonlyMap<
  string,
  string
> = new Map([
  [
    'safe-deployment',
    "healthCheckInvariants.ts 'safe-config' asserts the Safe owner set in both directions, so an owner the config does not declare is reported (PR #2337, EXSC-943). Removal, not detection, is tracked as EXSC-944: defaulting allowOverride to false and refusing a production threshold below SAFE_THRESHOLD retires this entry.",
  ],
])

/**
 * Slots the deployer's identities may occupy, as `<file>:<json path>`. Anything else is a
 * widening and refuses. `safeOwners` is listed without an index because owner order carries no
 * on-chain meaning; the count is bounded separately.
 */
export const DOCUMENTED_DEPLOYER_CONFIG_SLOTS: readonly string[] = [
  'global.json:deployerWallet',
  'global.json:safeOwners[]',
  'global.json:tronWallets.deployerWallet',
]

export interface IDeployerConfigSlot {
  /** `<file>:<json path>`, with array indices collapsed to `[]` for comparison. */
  slot: string
  /** The uncollapsed path, so a violation names the exact entry. */
  path: string
  value: string
}

interface IWalkTarget {
  file: string
  value: unknown
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Whether a string is written as a hexadecimal address, with or without `0x`.
 *
 * Case-insensitive on the prefix as well as the body: `0X` is the same address, and a form
 * this returns false for is compared verbatim instead, which is how an equivalent spelling
 * escapes the walk entirely.
 * @param id - the candidate string
 * @returns Whether it is a 40- or 42-digit hexadecimal address in either form
 */
const isHexAddressForm = (id: string): boolean =>
  /^(?:0x)?(?:[0-9a-f]{40}|[0-9a-f]{42})$/iu.test(id)

/** Identity strings the deployer key answers to across the config files. */
export const deployerIdentities = (globalConfig: {
  deployerWallet: string
  tronWallets?: Record<string, string>
}): string[] => {
  const declared = [
    globalConfig.deployerWallet,
    globalConfig.tronWallets?.deployerWallet,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0)

  const evm = globalConfig.deployerWallet
  const tronHexForms =
    typeof evm === 'string' && /^0x[0-9a-fA-F]{40}$/.test(evm)
      ? [`41${evm.slice(2)}`, `0x41${evm.slice(2)}`]
      : []

  return [...new Set([...declared, ...tronHexForms])]
}

/**
 * Compares two hexadecimal address strings ignoring the `0x` and its case.
 *
 * The prefix is optional in the source data but carries no meaning, so a slot writing an
 * identity without it would otherwise be a string the walk does not recognise — and an
 * identity the walk cannot recognise is one the bound cannot claim anything about.
 * @param value - a hexadecimal address in either form
 * @returns The lowercase body, with no prefix
 */
const hexAddressBody = (value: string): string =>
  value.replace(/^0x/iu, '').toLowerCase()

const matches = (value: string, identities: string[]): boolean =>
  identities.some((id) =>
    isHexAddressForm(id) && isHexAddressForm(value)
      ? hexAddressBody(value) === hexAddressBody(id)
      : value === id
  )

/** Every slot in the given configs holding a deployer identity, as a value or as an object key. */
export const findDeployerConfigSlots = (
  globalConfig: unknown,
  networksConfig: unknown
): IDeployerConfigSlot[] => {
  if (!isPlainObject(globalConfig))
    throw new Error('global config must be an object')
  if (
    !isPlainObject(networksConfig) ||
    Object.keys(networksConfig).length === 0
  )
    throw new Error('networks config must be a non-empty object')

  const declaredDeployer = (globalConfig as { deployerWallet?: unknown })
    .deployerWallet
  if (typeof declaredDeployer !== 'string' || declaredDeployer.length === 0)
    throw new Error('config/global.json declares no deployerWallet')

  const identities = deployerIdentities(
    globalConfig as { deployerWallet: string }
  )

  const found: IDeployerConfigSlot[] = []
  const collapse = (path: string): string => path.replace(/\[\d+]/g, '[]')

  const walk = (file: string, node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (matches(node, identities))
        found.push({
          slot: `${file}:${collapse(path)}`,
          path: `${file}:${path}`,
          value: node,
        })
      return
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(file, child, `${path}[${i}]`))
      return
    }
    if (isPlainObject(node))
      for (const [key, child] of Object.entries(node)) {
        const childPath = path === '' ? key : `${path}.${key}`
        if (matches(key, identities))
          found.push({
            slot: `${file}:${collapse(childPath)}`,
            path: `${file}:${childPath}`,
            value: key,
          })
        walk(file, child, childPath)
      }
  }

  const targets: IWalkTarget[] = [
    { file: 'global.json', value: globalConfig },
    { file: 'networks.json', value: networksConfig },
  ]
  for (const { file, value } of targets) walk(file, value, '')

  return found
}

export interface IDeployerPowerBoundOptions {
  /** Safe signature threshold the fleet is held to. Defaults to the repo constant. */
  safeThreshold?: number
  /** Inventory to judge. Defaults to {@link DEPLOYER_KEY_POWERS}. */
  powers?: readonly IDeployerPower[]
}

/**
 * Refuse if the deployer wallet occupies a config slot outside the documented set, if it occupies
 * more than the one Safe-owner slot the signature arithmetic assumes, if that slot could by itself
 * reach the signature threshold, or if the inventory claims an integrity power in production
 * steady state that {@link ACKNOWLEDGED_PRODUCTION_INTEGRITY_POWERS} does not disclose.
 *
 * Every leg is collected before throwing, so one violation never hides another.
 */
export const assertDeployerKeyPowerBounded = (
  globalConfig: unknown,
  networksConfig: unknown,
  options: IDeployerPowerBoundOptions = {}
): void => {
  const threshold = options.safeThreshold ?? SAFE_THRESHOLD
  const violations: string[] = []

  const slots = findDeployerConfigSlots(globalConfig, networksConfig)
  const documented = new Set(DOCUMENTED_DEPLOYER_CONFIG_SLOTS)
  for (const { slot, path, value } of slots)
    if (!documented.has(slot))
      violations.push(
        `undocumented grant: ${path} = ${value} (slot ${slot} is not in DOCUMENTED_DEPLOYER_CONFIG_SLOTS)`
      )

  const ownerSlots = slots.filter(
    (s) => s.slot === 'global.json:safeOwners[]'
  ).length
  if (ownerSlots > 1)
    violations.push(
      `deployer occupies ${ownerSlots} safeOwners slots, expected at most 1 — the human-signature count the process documents is derived from that`
    )
  if (!Number.isInteger(threshold) || threshold < 1)
    violations.push(
      `safe threshold must be a positive integer, got ${threshold}`
    )
  else if (ownerSlots >= threshold)
    violations.push(
      `deployer holds ${ownerSlots} of ${threshold} required Safe signatures — the key alone reaches the threshold, so its power is no longer bounded to DoS`
    )

  for (const power of options.powers ?? DEPLOYER_KEY_POWERS)
    if (
      power.status === 'current' &&
      power.scope === 'production-mainnet' &&
      power.class === 'integrity'
    ) {
      const detection = ACKNOWLEDGED_PRODUCTION_INTEGRITY_POWERS.get(power.id)
      if (detection === undefined || detection.trim().length === 0)
        violations.push(
          `inventory claims an undisclosed integrity power in production steady state: ${power.id} — either it is not an integrity power, or R7.1's bound needs restating and ACKNOWLEDGED_PRODUCTION_INTEGRITY_POWERS must name the check that observes it`
        )
    }

  if (violations.length > 0)
    throw new Error(
      `deployer key power is not bounded to the documented set:\n${violations
        .map((v) => `  - ${v}`)
        .join('\n')}`
    )
}

export const renderDeployerKeyPowerInventory = (
  globalConfig: unknown,
  networksConfig: unknown,
  options: IDeployerPowerBoundOptions = {}
): string => {
  const threshold = options.safeThreshold ?? SAFE_THRESHOLD
  const slots = findDeployerConfigSlots(globalConfig, networksConfig)
  const lines = [
    'Deployer key power inventory (R7.1)',
    '',
    `Safe signature threshold: ${threshold}`,
    `Config slots holding a deployer identity: ${slots.length}`,
    ...slots.map((s) => `  ${s.path} = ${s.value}`),
    '',
    'Powers:',
    ...(options.powers ?? DEPLOYER_KEY_POWERS).map(
      (p) =>
        `  [${p.status}] [${p.scope}] [${p.class}] ${p.id}: ${p.power}\n      surface: ${p.surface}\n      ${p.note}`
    ),
    '',
    'Disclosed production-mainnet integrity powers (observable, not prevented):',
    ...[...ACKNOWLEDGED_PRODUCTION_INTEGRITY_POWERS].map(
      ([id, detection]) => `  ${id}: ${detection}`
    ),
  ]
  return lines.join('\n')
}

const main = defineCommand({
  meta: {
    name: 'deployer-key-power',
    description:
      "Prints the deployer key's power inventory and asserts config grants it nothing outside the documented set (R7.1)",
  },
  run() {
    consola.log(
      renderDeployerKeyPowerInventory(globalConfigJson, networksConfigJson)
    )
    try {
      assertDeployerKeyPowerBounded(globalConfigJson, networksConfigJson)
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
    consola.success(
      'Deployer key power on production mainnets is bounded to the documented set, apart from the disclosed integrity powers above (config assertion over config/global.json and config/networks.json passed)'
    )
  },
})

if (import.meta.main) runMain(main)
