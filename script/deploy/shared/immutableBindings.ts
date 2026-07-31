/**
 * Immutable-binding ↔ config drift detection (EXSC-684 follow-up).
 *
 * Several periphery contracts bind external protocol addresses immutably at construction
 * (`ReceiverAcrossV4.SPOKEPOOL`, `ReceiverStargateV2.tokenMessaging`, ...). When the integration
 * migrates and the config file moves on, nothing used to compare the live binding against config —
 * presence and executor-binding checks stay green while destination calls fail against a dead
 * counterparty.
 *
 * `script/deploy/resources/deployRequirements.json` already maps each constructor arg to a config
 * file + per-network key. An entry annotated with a `getter` (the public getter exposing the bound
 * value) becomes checkable: this module resolves the expected value from config, and the
 * `immutable-bindings-match-config` health-check invariant reads the getter on chain and compares.
 * Coverage grows by annotating entries — args without a `getter` are skipped. Only address-typed
 * bindings are supported.
 */
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

import deployRequirementsJson from '../resources/deployRequirements.json'

/** One constructor arg in `deployRequirements.json` → `configData`. */
export interface IDeployRequirementConfigData {
  configFileName: string
  keyInConfigFile: string
  allowToDeployWithZeroAddress?: string
  /** Public getter exposing the bound value on chain. Present = checkable by the invariant. */
  getter?: string
}

/** The subset of a `deployRequirements.json` entry this module consumes. */
export interface IDeployRequirementEntry {
  configData?: Record<string, IDeployRequirementConfigData>
}

/** One verifiable binding: contract + getter + the config-resolved expected address. */
export interface IImmutableBindingCheck {
  contractName: string
  argName: string
  getter: string
  configFileName: string
  keyInConfigFile: string
  /** Checksum-cased expected address, or null when config has no value for this network. */
  expectedAddress: string | null
}

/**
 * Config file names in `deployRequirements.json` are plain basenames like `across.json`. Reject
 * anything else so a name can never traverse outside `config/` once composed into a file path.
 */
export function isValidConfigFileName(name: string): boolean {
  return /^[A-Za-z0-9_-]+\.json$/.test(name)
}

/**
 * Load and parse a config file from `config/`. Returns null when the name is not a plain
 * basename, the file is missing, or it does not parse — callers treat null as "expected value
 * unknown", never as "binding wrong".
 */
export function loadConfigFileFromDisk(fileName: string): unknown {
  if (!isValidConfigFileName(fileName)) return null

  const configDir = resolve(process.cwd(), 'config')
  const path = resolve(configDir, fileName)
  // Belt-and-braces on top of the name check: the resolved path must stay inside config/, so no
  // combination of inputs can make this read an arbitrary file.
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
 * Resolve a `keyInConfigFile` path like `.<NETWORK>.acrossSpokePool` against a parsed config
 * object. `<NETWORK>`/`<ENVIRONMENT>` placeholders are substituted first; the remaining plain
 * dot-path is walked segment by segment.
 *
 * @returns the string value at the path, or null when any segment is absent or the value is not
 *   a non-empty string
 */
export function resolveConfigValue(
  config: unknown,
  keyInConfigFile: string,
  network: string,
  environment: string
): string | null {
  const substituted = keyInConfigFile
    .replace(/<NETWORK>/g, network)
    .replace(/<ENVIRONMENT>/g, environment)
  const segments = substituted.replace(/^\./, '').split('.')

  let current: unknown = config
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) return null
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'string' && current.length > 0 ? current : null
}

/**
 * Collect every checkable immutable binding for one network: all `deployRequirements.json`
 * entries whose configData carries a `getter` annotation, with the expected address resolved
 * from the referenced config file. Pure given the injected loader — callers do the on-chain
 * read and comparison.
 *
 * @param network - network key as in `config/networks.json`
 * @param environment - `production` | `staging` (substituted into `<ENVIRONMENT>` keys)
 * @param deployRequirements - registry override, for tests
 * @param loadConfigFile - config loader; injectable for tests, defaults to reading `config/`
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

  for (const [contractName, entry] of Object.entries(deployRequirements)) {
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
        configFileName: configData.configFileName,
        keyInConfigFile: configData.keyInConfigFile,
        expectedAddress,
      })
    }
  }

  return checks.sort((a, b) =>
    `${a.contractName}.${a.argName}`.localeCompare(
      `${b.contractName}.${b.argName}`
    )
  )
}
