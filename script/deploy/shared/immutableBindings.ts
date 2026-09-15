/**
 * Resolves the expected value of an immutable constructor binding from the deploy-requirements
 * registry, so a health check can compare it against what the deployed contract actually holds.
 *
 * Import this from the `immutable-bindings-match-config` health-check invariant, or from any
 * tooling that needs the config-side expectation for a contract's immutably bound counterparty.
 * `script/deploy/resources/deployRequirements.json` already maps each constructor arg to a config
 * file plus a per-network key; an arg additionally annotated with a `getter` (the public getter
 * exposing the bound value on chain) becomes checkable. Coverage grows by adding annotations —
 * args without a `getter` are skipped, and only address-typed bindings are supported.
 *
 * Also exposes the two classifiers a caller needs before it can compare safely: whether a
 * contract is a facet (facets and periphery resolve their live address differently) and whether a
 * value is the zero address in any of the encodings a read can return, plus the version lookup
 * that tells a caller whether the live build is old enough to have no such getter at all.
 */
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

import deployRequirementsJson from '../resources/deployRequirements.json'

/**
 * Tron's zero address in base58; a TVM `address` read can also return it 41-hex encoded, and an
 * unregistered PeripheryRegistry name resolves to it.
 */
export const TRON_ZERO_ADDRESS_BASE58 = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'

/** One constructor arg under a `deployRequirements.json` entry's `configData`. */
export interface IDeployRequirementConfigData {
  configFileName: string
  keyInConfigFile: string
  allowToDeployWithZeroAddress?: string
  /** Public getter exposing the bound value on chain. Present = checkable by the invariant. */
  getter?: string
  /**
   * Earlier names of the same getter, for chains still running a build from before it was
   * renamed. Without these the read reverts and the binding silently goes unverified — most of
   * the fleet still exposes `DeBridgeDlnFacet.dlnSource()` rather than `DLN_SOURCE()`.
   */
  legacyGetters?: string[]
  /**
   * The contract version that first exposed `getter`. A build older than this has no such
   * function, so the read can only revert — reporting that as an unverified binding describes a
   * pending upgrade, not a hole in this check. Omit whenever the getter has always been there.
   */
  getterSinceVersion?: string
}

/** The subset of a `deployRequirements.json` entry this module consumes. */
export interface IDeployRequirementEntry {
  configData?: Record<string, IDeployRequirementConfigData>
}

/** One verifiable binding: contract, its getter, and the config-resolved expected address. */
export interface IImmutableBindingCheck {
  contractName: string
  argName: string
  getter: string
  /** Earlier names of `getter`, tried only when the current one is absent from the live build. */
  legacyGetters: string[]
  /**
   * {@link IDeployRequirementConfigData.getterSinceVersion}, or null when the annotation is
   * absent — in which case every live build is expected to answer the read.
   */
  getterSinceVersion: string | null
  configFileName: string
  keyInConfigFile: string
  /**
   * The key that actually resolved — a `.<network>` override where one exists, otherwise
   * `keyInConfigFile` — with placeholders substituted, for messages a human has to read.
   */
  resolvedKeyInConfigFile: string
  /** Expected address as written in config, or null when config has no value for this network. */
  expectedAddress: string | null
  /**
   * The registry's `allowToDeployWithZeroAddress`, i.e. whether a zero binding is a declared
   * value here rather than drift. Absent in the registry reads as false, so an unstated flag
   * keeps the strict comparison.
   */
  zeroAddressAllowed: boolean
  /**
   * Whether the referenced config file parsed into an object keys can be read from. A null
   * `expectedAddress` means "this network has no value" only when this is true; on a false it
   * means the expectation is unknown, which is not the same thing and must not be read as a
   * zero expectation.
   */
  configFileLoaded: boolean
}

/**
 * Whether a value is the zero address in any encoding a Tron or EVM read can produce: base58,
 * `41`-prefixed hex, or `0x`-prefixed hex.
 *
 * @remarks Hex is compared case-insensitively; base58 is not, because base58 is case-significant
 *   and lowercasing a Tron address corrupts it.
 * @param value - raw address value as read from chain or config
 * @returns true when the value denotes the zero address
 */
export function isZeroAddressValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === TRON_ZERO_ADDRESS_BASE58) return true
  return /^(0x|41)?0{40}$/i.test(trimmed)
}

/**
 * Substitute the `<NETWORK>` / `<ENVIRONMENT>` placeholders in a registry config key.
 *
 * @param keyInConfigFile - dot path as written in the registry
 * @param network - network key as in `config/networks.json`
 * @param environment - `production` or `staging`
 * @returns the key with placeholders replaced, for both lookup and human-readable output
 */
export function substituteConfigKeyPlaceholders(
  keyInConfigFile: string,
  network: string,
  environment: string
): string {
  return keyInConfigFile
    .replace(/<NETWORK>/g, network)
    .replace(/<ENVIRONMENT>/g, environment)
}

/**
 * Whether a contract is a Diamond facet, decided by the presence of `src/Facets/<name>.sol`.
 *
 * @remarks Callers need this because the two kinds resolve their live address differently: a
 *   facet's is the one the diamond serves, a periphery contract's comes from the
 *   PeripheryRegistry or the deploy log. Guessing wrong on a facet during the window between its
 *   deploy and its diamondCut reads a contract that is not live yet.
 * @param contractName - Solidity contract identifier
 * @param fileExists - existence probe; injectable for tests
 * @returns true when a facet source file of that name exists
 */
export function isFacetContract(
  contractName: string,
  fileExists: (filePath: string) => boolean = existsSync
): boolean {
  if (!/^[A-Za-z0-9_]+$/.test(contractName)) return false
  return fileExists(
    resolve(process.cwd(), 'src', 'Facets', `${contractName}.sol`)
  )
}

/**
 * Whether a config file name is a plain basename, so it can never traverse outside `config/`
 * once composed into a file path.
 *
 * @param name - the `configFileName` value from the registry
 * @returns true when the name is safe to resolve inside `config/`
 */
export function isValidConfigFileName(name: string): boolean {
  return /^[A-Za-z0-9_-]+\.json$/.test(name)
}

/**
 * Load and parse a config file from `config/`.
 *
 * @param fileName - plain basename, e.g. `across.json`
 * @returns the parsed JSON, or null when the name is not a plain basename, the file is missing,
 *   or it does not parse — callers treat null as "expected value unknown", never "binding wrong"
 */
export function loadConfigFileFromDisk(fileName: string): unknown {
  if (!isValidConfigFileName(fileName)) return null

  const configDir = resolve(process.cwd(), 'config')
  const path = resolve(configDir, fileName)
  const relativeToDir = relative(configDir, path)
  if (relativeToDir.startsWith('..') || isAbsolute(relativeToDir)) return null

  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Resolve a registry `keyInConfigFile` path such as `.<NETWORK>.acrossSpokePool` against a parsed
 * config object.
 *
 * @param config - parsed config file contents
 * @param keyInConfigFile - dot path, optionally containing `<NETWORK>` / `<ENVIRONMENT>`
 * @param network - network key as in `config/networks.json`
 * @param environment - `production` or `staging`
 * @returns the string value at the path, or null when any segment is absent or the value is not
 *   a non-empty string
 */
export function resolveConfigValue(
  config: unknown,
  keyInConfigFile: string,
  network: string,
  environment: string
): string | null {
  const segments = substituteConfigKeyPlaceholders(
    keyInConfigFile,
    network,
    environment
  )
    .replace(/^\./, '')
    .split('.')

  let current: unknown = config
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) return null
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'string' && current.length > 0 ? current : null
}

/**
 * Resolve a binding's expected address, preferring a network-scoped override of the registry key
 * over the key as written.
 *
 * @remarks Registry keys that already carry a `<NETWORK>` placeholder address one network each,
 *   but a key without one is a fleet-wide default that a config file may still override per
 *   network — `lifiintentescrow.json` holds the EVM `OIFOutputSettlerSimple` at the top level and
 *   Tron's under `.tron`. Comparing a Tron deployment against the top-level EVM value reports a
 *   correctly bound contract as drift, so a `.<network>`-prefixed form of the same key wins
 *   whenever the config file defines it.
 * @param config - parsed config file contents, or null when it could not be loaded
 * @param keyInConfigFile - dot path as written in the registry
 * @param network - network key as in `config/networks.json`
 * @param environment - `production` or `staging`
 * @returns the key that answered (for human-readable output) and the value it resolved to, or a
 *   null value when config has nothing for this network
 */
export function resolveExpectedAddress(
  config: unknown,
  keyInConfigFile: string,
  network: string,
  environment: string
): { keyUsed: string; expectedAddress: string | null } {
  if (config === null)
    return { keyUsed: keyInConfigFile, expectedAddress: null }

  if (!/<NETWORK>|<ENVIRONMENT>/.test(keyInConfigFile)) {
    const scopedKey = `.${network}${
      keyInConfigFile.startsWith('.') ? '' : '.'
    }${keyInConfigFile}`
    const scopedValue = resolveConfigValue(
      config,
      scopedKey,
      network,
      environment
    )
    if (scopedValue !== null)
      return { keyUsed: scopedKey, expectedAddress: scopedValue }
  }

  return {
    keyUsed: keyInConfigFile,
    expectedAddress: resolveConfigValue(
      config,
      keyInConfigFile,
      network,
      environment
    ),
  }
}

/**
 * Collect every checkable immutable binding for one network: all registry entries whose
 * `configData` carries a `getter`, with the expected address resolved from the referenced config
 * file. Pure given the injected loader — the caller performs the on-chain read and comparison.
 *
 * @param network - network key as in `config/networks.json`
 * @param environment - `production` or `staging`, substituted into `<ENVIRONMENT>` keys
 * @param deployRequirements - registry override, for tests
 * @param loadConfigFile - config loader; injectable for tests, defaults to reading `config/`
 * @returns the checks, sorted by contract and arg name for stable output
 */
export function collectImmutableBindingChecks(
  network: string,
  environment: string,
  deployRequirements: Record<
    string,
    IDeployRequirementEntry
  > = deployRequirementsJson as Record<string, IDeployRequirementEntry>,
  loadConfigFile: (fileName: string) => unknown = loadConfigFileFromDisk
): IImmutableBindingCheck[] {
  const checks: IImmutableBindingCheck[] = []

  for (const [contractName, entry] of Object.entries(deployRequirements))
    for (const [argName, configData] of Object.entries(
      entry.configData ?? {}
    )) {
      if (!configData.getter) continue

      const config = loadConfigFile(configData.configFileName)
      // Anything but a plain object is unusable as config, and passing one on would let a
      // numeric path segment index a list into an expectation the caller is told not to trust.
      const configFileLoaded =
        typeof config === 'object' && config !== null && !Array.isArray(config)
      const { keyUsed, expectedAddress } = resolveExpectedAddress(
        configFileLoaded ? config : null,
        configData.keyInConfigFile,
        network,
        environment
      )

      checks.push({
        contractName,
        argName,
        getter: configData.getter,
        legacyGetters: configData.legacyGetters ?? [],
        getterSinceVersion: configData.getterSinceVersion ?? null,
        configFileName: configData.configFileName,
        keyInConfigFile: configData.keyInConfigFile,
        resolvedKeyInConfigFile: substituteConfigKeyPlaceholders(
          keyUsed,
          network,
          environment
        ),
        expectedAddress,
        zeroAddressAllowed: configData.allowToDeployWithZeroAddress === 'true',
        configFileLoaded,
      })
    }

  return checks.sort((a, b) =>
    `${a.contractName}.${a.argName}`.localeCompare(
      `${b.contractName}.${b.argName}`
    )
  )
}

/** The shape every contract version in this repo takes; anything else this cannot order. */
const CONTRACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/**
 * Split a `major.minor.patch` version into its numeric parts.
 *
 * @param value - version as written in a deployment log or in the registry
 * @returns the three parts, or null when the string is not a three-part numeric version
 */
function parseContractVersion(value: string): number[] | null {
  const trimmed = value.trim()
  if (!CONTRACT_VERSION_PATTERN.test(trimmed)) return null
  return trimmed.split('.').map(Number)
}

/**
 * Order two contract versions.
 *
 * @remarks Returns null rather than guessing when either side is unparseable. Both sides can be:
 *   the diamond log leaves a version blank for facets it could not identify, and a registry
 *   annotation is hand-written. An invented ordering for either would silently exempt a binding
 *   from the check that exists to compare it.
 * @param left - version to order
 * @param right - version to order against
 * @returns negative when `left` precedes `right`, zero when equal, positive when it follows, or
 *   null when either is not a three-part numeric version
 */
export function compareContractVersions(
  left: string,
  right: string
): number | null {
  const leftParts = parseContractVersion(left)
  const rightParts = parseContractVersion(right)
  if (leftParts === null || rightParts === null) return null

  for (let index = 0; index < 3; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** The `LiFiDiamond.Facets` section of `deployments/<network>.diamond.json`, keyed by address. */
export type DiamondFacetLog = Record<
  string,
  { Name?: string; Version?: string }
>

/** Network keys compose into a path, so anything outside this shape is refused outright. */
function isValidNetworkName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name)
}

/** Memoized per network: a fleet run reads each diamond log once, not once per check. */
const diamondFacetLogCache = new Map<string, DiamondFacetLog | null>()

/**
 * Read the facets a network's diamond log records, keyed by the address each is registered at.
 *
 * @remarks This log is the diamond's own record of what it serves, so it names a version for
 *   every registered facet — including chains the master deployment log has not caught up with.
 *   It has no equivalent for periphery, which it stores as bare name-to-address pairs.
 * @param networkLower - canonical lowercase network key
 * @returns the facet section, or null when the log is missing or does not parse
 */
export function loadDiamondFacetLogFromDisk(
  networkLower: string
): DiamondFacetLog | null {
  const cached = diamondFacetLogCache.get(networkLower)
  if (cached !== undefined) return cached

  const resolved = readDiamondFacetLog(networkLower)
  diamondFacetLogCache.set(networkLower, resolved)
  return resolved
}

/** The uncached read behind {@link loadDiamondFacetLogFromDisk}. */
function readDiamondFacetLog(networkLower: string): DiamondFacetLog | null {
  if (!isValidNetworkName(networkLower)) return null

  const deploymentsDir = resolve(process.cwd(), 'deployments')
  const path = resolve(deploymentsDir, `${networkLower}.diamond.json`)
  const relativeToDir = relative(deploymentsDir, path)
  if (relativeToDir.startsWith('..') || isAbsolute(relativeToDir)) return null

  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      LiFiDiamond?: { Facets?: DiamondFacetLog }
    }
    return parsed.LiFiDiamond?.Facets ?? null
  } catch {
    return null
  }
}

/**
 * Whether two addresses denote the same contract.
 *
 * @remarks Hex compares case-insensitively because a log and a chain read disagree on checksum
 *   casing. Tron's base58 does not: case carries information there, and lowercasing it would let
 *   two distinct addresses compare equal.
 */
function addressesMatch(left: string, right: string): boolean {
  const leftTrimmed = left.trim()
  const rightTrimmed = right.trim()
  if (leftTrimmed.startsWith('0x') && rightTrimmed.startsWith('0x'))
    return leftTrimmed.toLowerCase() === rightTrimmed.toLowerCase()
  return leftTrimmed === rightTrimmed
}

/**
 * Resolve which version of a facet the diamond has registered at an address.
 *
 * @remarks The log entry must also name the contract the caller asked about. Keying by address
 *   alone would answer from a record that has since been reassigned to another facet, and a
 *   version read off the wrong contract is worse than no version at all.
 * @param contractName - Solidity contract identifier, as the log names it
 * @param networkLower - canonical lowercase network key
 * @param address - the registered address, hex or Tron base58
 * @param log - log override, for tests; defaults to reading `deployments/`
 * @returns the registered version, or null when the log records no usable one for that address
 */
export function resolveRegisteredFacetVersion(
  contractName: string,
  networkLower: string,
  address: string,
  log: DiamondFacetLog | null = loadDiamondFacetLogFromDisk(networkLower)
): string | null {
  if (log === null) return null

  for (const [loggedAddress, entry] of Object.entries(log)) {
    if (!addressesMatch(loggedAddress, address)) continue
    if (entry?.Name !== contractName) continue
    const version = entry.Version
    return typeof version === 'string' && version.trim() !== '' ? version : null
  }
  return null
}
