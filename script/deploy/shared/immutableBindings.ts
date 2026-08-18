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
 * value is the zero address in any of the encodings a read can return.
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
  configFileName: string
  keyInConfigFile: string
  /** `keyInConfigFile` with placeholders substituted, for messages a human has to read. */
  resolvedKeyInConfigFile: string
  /** Expected address as written in config, or null when config has no value for this network. */
  expectedAddress: string | null
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
 * Strip URLs from a message before it is logged.
 *
 * @remarks Tooling failures often echo the invocation that failed, and on Tron that invocation
 *   carries the RPC URL — which frequently embeds an API key. CI masks those, local runs do not.
 * @param message - raw error or diagnostic text
 * @returns the message with every URL replaced by a placeholder
 */
export function redactUrls(message: string): string {
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '<redacted-url>')
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
      const expectedAddress =
        config === null
          ? null
          : resolveConfigValue(
              config,
              configData.keyInConfigFile,
              network,
              environment
            )

      checks.push({
        contractName,
        argName,
        getter: configData.getter,
        legacyGetters: configData.legacyGetters ?? [],
        configFileName: configData.configFileName,
        keyInConfigFile: configData.keyInConfigFile,
        resolvedKeyInConfigFile: substituteConfigKeyPlaceholders(
          configData.keyInConfigFile,
          network,
          environment
        ),
        expectedAddress,
      })
    }

  return checks.sort((a, b) =>
    `${a.contractName}.${a.argName}`.localeCompare(
      `${b.contractName}.${b.argName}`
    )
  )
}
