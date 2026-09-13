/**
 * What the pre-broadcast gate is allowed to compare live chain state against:
 * the storage authorities `main` declares, and the addresses an operation's
 * calldata names.
 *
 * Import this from the gate. Every value here derives from `main` — the
 * deployments file, `config/global.json` — or from the operation's own
 * parameters. Nothing reads a stored verdict.
 */

import { parseAbi } from 'viem'

import { strip0x } from '../codehash/hex'

const EVM_WORD_HEX_CHARS = 64
const ADDRESS_HEX_CHARS = 40
/** Also the scan stride: a nested frame is offset by its own selector. */
const SELECTOR_HEX_CHARS = 8
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Which live value a declared storage authority reads, and where `main` says
 * what it should be.
 *
 * The table is keyed by contract name and is consulted only for addresses the
 * deployments file already named, so an unknown address never silently acquires
 * "no authorities to check".
 */
export type AuthorityExpectationSource =
  | { from: 'deployments'; contractName: string }
  | { from: 'globalConfig'; key: string }

/**
 * The getters the gate can call. Kept beside the table below so a getter
 * declared there but not here fails to compile, rather than becoming a run-time
 * read error the gate cannot tell apart from an unreachable node.
 */
export const AUTHORITY_ABI = parseAbi([
  'function owner() view returns (address)',
  'function pauserWallet() view returns (address)',
])

export type AuthorityGetter = Extract<
  (typeof AUTHORITY_ABI)[number],
  { type: 'function' }
>['name']

export interface IDeclaredAuthority {
  /** Zero-argument view function returning an address. */
  getter: AuthorityGetter
  source: AuthorityExpectationSource
}

/**
 * The storage-authority values this gate asserts, per contract (R2.6 / F9).
 *
 * A code MATCH says nothing about mutable storage, so the authority that can
 * redirect a contract has to be read live and compared too. A contract absent
 * from this table contributes no authority row and produces no finding, so the
 * gate's PROCEED covers only the authorities named here — absence of a row is
 * not evidence that a contract's authorities were checked.
 */
export const DECLARED_STORAGE_AUTHORITIES: Readonly<
  Record<string, readonly IDeclaredAuthority[]>
> = {
  LiFiDiamond: [
    {
      getter: 'owner',
      source: { from: 'deployments', contractName: 'LiFiTimelockController' },
    },
    {
      getter: 'pauserWallet',
      source: { from: 'globalConfig', key: 'pauserWallet' },
    },
  ],
  ERC20Proxy: [
    {
      getter: 'owner',
      source: { from: 'globalConfig', key: 'refundWallet' },
    },
  ],
}

/** One R2.6 storage-authority value: what is live versus what `main` declares. */
export interface IPreBroadcastAuthority {
  /** Identifies the value for the operator, e.g. `LiFiDiamond.owner`. */
  label: string
  /** Live on-chain value, lowercased; undefined when the read failed. */
  liveValue: string | undefined
  /** Value `main` declares, lowercased; undefined when it declares none. */
  expectedValue: string | undefined
  /**
   * Where that declaration came from. Carried because a comparison is only as
   * good as its expectation: a value read back from the deployment record is
   * proposer-writable, and the ledger must anchor the row on that rather than
   * on the live read.
   */
  expectationSource: AuthorityExpectationSource['from']
  /** Why the live read yielded nothing. */
  readError: string | undefined
}

/**
 * Every address in an operation's calldata that `main` can name.
 *
 * Word-scans each payload rather than decoding it: the set of functions a
 * timelock operation may carry is open, so a decoder-driven list covers
 * whatever it was taught and silently omits the rest. A 32-byte word whose low
 * 20 bytes name a contract in the deployments file is an address this operation
 * touches, whichever call put it there.
 *
 * @param targets - Inner-call targets from the operation parameters.
 * @param payloads - Inner-call payloads from the operation parameters.
 * @param knownAddresses - Lowercased addresses the deployments file holds.
 * @returns Lowercased addresses, deduplicated, targets first.
 */
export const extractCalldataAddresses = (
  targets: readonly string[],
  payloads: readonly string[],
  knownAddresses: ReadonlySet<string>
): string[] => {
  const found = new Set<string>()

  for (const target of targets) {
    const lowered = target.trim().toLowerCase()
    if (lowered.length > 0) found.add(lowered)
  }

  for (const payload of payloads) {
    const body = strip0x(payload ?? '')
    // Every 4-byte alignment, not only the top-level frame's: a call carried in
    // a `bytes` argument — `diamondCut`'s init `_calldata` — shifts all of its
    // own words by its own selector, so an address reachable only through a
    // nested frame sits on no 32-byte stride and would get no row at all.
    for (
      let offset = 0;
      offset + EVM_WORD_HEX_CHARS <= body.length;
      offset += SELECTOR_HEX_CHARS
    ) {
      const word = body.slice(offset, offset + EVM_WORD_HEX_CHARS).toLowerCase()
      const candidate = `0x${word.slice(
        EVM_WORD_HEX_CHARS - ADDRESS_HEX_CHARS
      )}`
      if (candidate === ZERO_ADDRESS) continue
      if (knownAddresses.has(candidate)) found.add(candidate)
    }
  }

  return [...found]
}

/**
 * Inverts a deployments file into address → contract name.
 *
 * Keys on the address bytes alone. A name is a label chosen for display and can
 * be normalised, trimmed or coerced on the way to a screen; the address is what
 * executes, so it is the only thing this index may be looked up by.
 *
 * @param deployments - Parsed `deployments/<network>.json`, name → address.
 * @returns Lowercased address → contract name. An address bound to more than
 * one name maps to undefined, because there is then no single contract to
 * compare its code against.
 */
export const buildAddressNameIndex = (
  deployments: Record<string, unknown>
): Map<string, string | undefined> => {
  const index = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(deployments)) {
    if (typeof value !== 'string') continue
    const address = value.trim().toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue
    if (index.has(address) && index.get(address) !== name)
      index.set(address, undefined)
    else index.set(address, name)
  }
  return index
}

/**
 * Resolves what `main` declares a storage authority should hold.
 *
 * @param source - Where the expectation is declared.
 * @param deployments - Parsed deployments file for the network.
 * @param globalConfig - Parsed `config/global.json`.
 * @returns The lowercased expected address, or undefined when `main` declares
 * none. Undefined is never coerced to a default: the gate holds on it.
 */
export const resolveExpectedAuthority = (
  source: AuthorityExpectationSource,
  deployments: Record<string, unknown>,
  globalConfig: Record<string, unknown>
): string | undefined => {
  const raw =
    source.from === 'deployments'
      ? deployments[source.contractName]
      : globalConfig[source.key]
  if (typeof raw !== 'string') return undefined
  const address = raw.trim().toLowerCase()
  return /^0x[0-9a-f]{40}$/.test(address) ? address : undefined
}
