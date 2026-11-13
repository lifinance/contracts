/**
 * Tron spellings for the timelock watcher: main names Tron contracts and wallets
 * in base58, while the chain's logs, its reads and every watcher check compare
 * 20-byte hex. Imported by the watcher when it watches a Tron network.
 */

import {
  evm20HexStringToTronBase58,
  getTronWebCodecOnlyForNetwork,
} from '@lifi/tron-devkit'
import type { Address } from 'viem'

import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'

const TRON_BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const EVM_HEX = /^0x[0-9a-fA-F]{40}$/

const isBase58 = (value: unknown): value is string =>
  typeof value === 'string' && TRON_BASE58.test(value)

/**
 * The 20-byte hex of a Tron address. The conversion drops the version byte
 * unchecked, so a checksum-valid string under another version byte would
 * otherwise convert to a different account's hex.
 */
const tronHex = (network: string, base58: string): Address => {
  const hex = normalizeAddressForNetwork(network, base58)
  const tronWeb = getTronWebCodecOnlyForNetwork(network)
  if (evm20HexStringToTronBase58(tronWeb, hex) !== base58)
    throw new Error(
      `${base58} is not a Tron account address: its version byte is not 0x41`
    )
  return hex
}

/**
 * A deployments file with every base58 address spelled as hex.
 *
 * @param network - Tron network name.
 * @param deployments - Main's parsed `deployments/<network>.json`.
 * @returns A copy whose base58 addresses are checksummed hex; other values unchanged.
 * @throws When a base58-shaped value fails its checksum or is not a Tron account.
 */
export const tronDeploymentsAsHex = (
  network: string,
  deployments: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(deployments).map(([name, value]) => [
      name,
      isBase58(value) ? tronHex(network, value) : value,
    ])
  )

/**
 * The global config with every EVM wallet replaced by its `tronWallets`
 * counterpart, in hex: main lists Tron's wallets separately, so they can
 * differ. No EVM wallet survives, so none is accepted as a Tron recipient.
 *
 * @param network - Tron network name.
 * @param globalConfig - Parsed `config/global.json`.
 * @returns A copy whose wallet keys hold the Tron wallets in hex.
 * @throws When `tronWallets` is missing, lacks a wallet the EVM config names,
 *   or holds a value that is not a valid Tron address.
 */
export const withTronWallets = (
  network: string,
  globalConfig: Record<string, unknown>
): Record<string, unknown> => {
  const wallets = globalConfig['tronWallets']
  if (typeof wallets !== 'object' || wallets === null)
    throw new Error('config/global.json has no tronWallets')
  const tronWallets = wallets as Record<string, unknown>
  const overlay: Record<string, string> = {}
  for (const [name, value] of Object.entries(globalConfig)) {
    if (typeof value !== 'string' || !EVM_HEX.test(value)) continue
    const tron = tronWallets[name]
    if (!isBase58(tron))
      throw new Error(
        `config/global.json tronWallets.${name} is missing or not a Tron address`
      )
    overlay[name] = tronHex(network, tron)
  }
  return { ...globalConfig, ...overlay }
}
