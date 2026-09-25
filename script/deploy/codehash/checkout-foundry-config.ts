/**
 * Reads the `foundry.toml` of a deployment commit's checkout, which the rebuild
 * is about to run forge in, and refuses one that could choose what executes.
 *
 * Per D3 that commit need only be fetchable, so whoever wrote the deployment
 * record wrote this file. Forge accepts a path wherever it accepts a solc
 * version — `solc`, `solc_version`, a legacy top-level `[default]` table — and
 * foundry-zksync adds `zksync.solc_path`, which merges past the `FOUNDRY_ZKSYNC`
 * the rebuild exports. Any of them runs a binary the commit tracks, on the
 * signer's machine, and that binary decides the bytecode the gate compares.
 *
 * Parsed as TOML rather than line by line: a line regex reads a `solc_version`
 * inside a `'''` string that forge treats as text, while forge follows the
 * `solc` key after it.
 *
 * Forge also reads any top-level table as a legacy profile of the same name,
 * so `[external]` beside a `[profile.external]` can name a `vyper.path` that
 * `FOUNDRY_SOLC` does not cover. A profile may not share a top-level name, and
 * every top-level section's contents are held to the shapes `main` has used.
 *
 * Every key set is an allowlist taken from every version of `foundry.toml` on
 * `main`, plus `src`. A key outside them refuses the rebuild until it is added
 * here, which is loud; a denylist would pass the executable-selecting key
 * nobody listed.
 * `ffi` is allowed: it gates cheatcodes in tests and scripts, and `forge build`
 * runs neither.
 */

import { parse } from 'smol-toml'

const ALLOWED_TOP_LEVEL = new Set([
  'profile',
  'rpc_endpoints',
  'etherscan',
  'lint',
  'external',
])

const ALLOWED_ETHERSCAN_KEYS = new Set(['key', 'url', 'chain', 'verifier'])

const ALLOWED_PROFILE_KEYS = new Set([
  'auto_detect_solc',
  'cache',
  'cache_path',
  'evm_version',
  'ffi',
  'fs_permissions',
  'fuzz',
  'libs',
  'lint_on_build',
  'optimizer',
  'optimizer_runs',
  'out',
  'script',
  'sender',
  'skip',
  'solc_version',
  'src',
  'test',
  'tx_origin',
  'via_ir',
  'zksolc',
  'zksync',
])

/** A version and nothing else: forge reads any other string as a path. */
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/

export interface ICheckoutProfile {
  profile: string
  solcVersion: string
  evmVersion: string
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date)

const vetVersion = (
  where: string,
  value: unknown,
  problems: string[]
): void => {
  if (typeof value !== 'string' || !PLAIN_VERSION.test(value))
    problems.push(
      `${where} = ${JSON.stringify(value)} is not a plain x.y.z version`
    )
}

/**
 * The history holds `zksync = { zksolc = … }`, and the same table nested
 * inside itself, so both shapes are accepted and nothing else is.
 */
const vetZksyncTable = (
  where: string,
  value: unknown,
  problems: string[]
): void => {
  if (!isTable(value)) {
    problems.push(`${where} is not a table`)
    return
  }
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'zksolc') vetVersion(`${where}.zksolc`, inner, problems)
    else if (key === 'zksync')
      vetZksyncTable(`${where}.zksync`, inner, problems)
    else problems.push(`${where}.${key} is not a key the rebuild allows`)
  }
}

/**
 * Holds each non-profile section to what it has carried on `main`, because
 * forge would read any of them as a profile's keys.
 */
const vetSections = (
  doc: Record<string, unknown>,
  problems: string[]
): void => {
  const refuse = (where: string): void => {
    problems.push(`${where} is not a value the rebuild allows`)
  }
  const { lint, external, rpc_endpoints: rpc, etherscan } = doc

  if (lint !== undefined) {
    if (!isTable(lint)) refuse('lint')
    else
      for (const [key, value] of Object.entries(lint))
        if (key !== 'lint_on_build' || typeof value !== 'boolean')
          refuse(`lint.${key}`)
  }

  if (external !== undefined) {
    if (!isTable(external)) refuse('external')
    else
      for (const [key, value] of Object.entries(external)) {
        if (key !== 'zksync' || !isTable(value)) {
          refuse(`external.${key}`)
          continue
        }
        for (const [pin, version] of Object.entries(value)) {
          if (pin === 'zksolc')
            vetVersion('external.zksync.zksolc', version, problems)
          else if (pin !== 'foundry_zksync' || typeof version !== 'string')
            refuse(`external.zksync.${pin}`)
        }
      }
  }

  if (rpc !== undefined) {
    if (!isTable(rpc)) refuse('rpc_endpoints')
    else
      for (const [key, value] of Object.entries(rpc))
        if (typeof value !== 'string') refuse(`rpc_endpoints.${key}`)
  }

  if (etherscan !== undefined) {
    if (!isTable(etherscan)) refuse('etherscan')
    else
      for (const [key, value] of Object.entries(etherscan)) {
        if (!isTable(value)) {
          refuse(`etherscan.${key}`)
          continue
        }
        for (const [field, inner] of Object.entries(value))
          if (
            !ALLOWED_ETHERSCAN_KEYS.has(field) ||
            (typeof inner !== 'string' && typeof inner !== 'number')
          )
            refuse(`etherscan.${key}.${field}`)
      }
  }
}

/**
 * The profiles in a checkout's `foundry.toml` that pin both a solc and an EVM
 * version, after refusing the file if it could select a compiler binary.
 *
 * @param toml - contents of the checkout's `foundry.toml`
 * @returns Every profile pinning both versions, keyed by name
 * @throws when the file is not TOML, or names any key or value outside the allowlists
 */
export const readCheckoutProfiles = (
  toml: string
): Record<string, ICheckoutProfile> => {
  let doc: Record<string, unknown>
  try {
    doc = parse(toml)
  } catch (error) {
    throw new Error(
      `its foundry.toml is not valid TOML (${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }), so what forge would read from it cannot be established`
    )
  }

  const problems: string[] = []
  for (const key of Object.keys(doc))
    if (!ALLOWED_TOP_LEVEL.has(key))
      problems.push(`top-level "${key}" is not a section the rebuild allows`)

  vetSections(doc, problems)

  const profiles = isTable(doc.profile) ? doc.profile : {}
  if (doc.profile !== undefined && !isTable(doc.profile))
    problems.push('"profile" is not a table')

  const found: Record<string, ICheckoutProfile> = {}
  for (const [name, body] of Object.entries(profiles)) {
    const where = `profile.${name}`
    if (name in doc)
      problems.push(
        `${where} shares its name with a top-level section forge would merge into it`
      )
    if (!isTable(body)) {
      problems.push(`${where} is not a table`)
      continue
    }
    for (const [key, value] of Object.entries(body)) {
      if (!ALLOWED_PROFILE_KEYS.has(key))
        problems.push(`${where}.${key} is not a key the rebuild allows`)
      else if (key === 'solc_version' || key === 'zksolc')
        vetVersion(`${where}.${key}`, value, problems)
      else if (key === 'zksync')
        vetZksyncTable(`${where}.zksync`, value, problems)
    }
    const { solc_version: solc, evm_version: evm } = body
    if (typeof solc === 'string' && typeof evm === 'string')
      found[name] = { profile: name, solcVersion: solc, evmVersion: evm }
  }

  if (problems.length > 0)
    throw new Error(
      `its foundry.toml could choose what the rebuild executes: ${problems.join(
        '; '
      )}`
    )
  return found
}
