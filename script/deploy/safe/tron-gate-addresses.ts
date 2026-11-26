/**
 * Tron spellings for the integrity gates: main names Tron contracts and wallets
 * in base58, while the chain's logs, its reads and every gate check compare
 * 20-byte hex. Imported by the timelock watcher, the sign-time storage-authority
 * observation and the pre-broadcast gate when they read a Tron network.
 */

import {
  evm20HexStringToTronBase58,
  getTronWebCodecOnlyForNetwork,
  isTronNetworkKey,
} from '@lifi/tron-devkit'
import { getAddress, type Address } from 'viem'

import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'

const TRON_BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const EVM_HEX = /^0x[0-9a-fA-F]{40}$/

const isBase58 = (value: unknown): value is string =>
  typeof value === 'string' && TRON_BASE58.test(value)

/**
 * The 20-byte hex of a Tron address. The conversion drops the version byte
 * unchecked, so a checksum-valid string under another version byte would
 * otherwise convert to a different account's hex.
 *
 * @param network - Tron network name.
 * @param address - A base58 Tron address, or one already spelled as 0x hex.
 * @returns Its checksummed 20-byte hex.
 * @throws When a base58 checksum fails or its version byte is not 0x41.
 */
export const tronHex = (network: string, address: string): Address => {
  if (EVM_HEX.test(address)) return getAddress(address)
  const hex = normalizeAddressForNetwork(network, address)
  const tronWeb = getTronWebCodecOnlyForNetwork(network)
  if (evm20HexStringToTronBase58(tronWeb, hex) !== address)
    throw new Error(
      `${address} is not a Tron account address: its version byte is not 0x41`
    )
  return hex
}

/**
 * A deployments file with every base58 address spelled as hex.
 *
 * Every entry of a deployments file is a contract address, so a value that is
 * neither base58 nor hex is malformed. It throws rather than passing through:
 * a passed-through value drops out of the gates' address index, and the
 * contract it names would go unchecked instead of failing.
 *
 * @param network - Tron network name.
 * @param deployments - Main's parsed `deployments/<network>.json`.
 * @returns A copy whose base58 addresses are checksummed hex; hex values unchanged.
 * @throws When a value is not an address, a base58 checksum fails, or a
 *   base58 address is not a Tron account.
 */
export const tronDeploymentsAsHex = (
  network: string,
  deployments: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(deployments).map(([name, value]) => {
      if (isBase58(value)) return [name, tronHex(network, value)]
      if (typeof value === 'string' && EVM_HEX.test(value)) return [name, value]
      throw new Error(
        `deployments/${network}.json ${name} is not a Tron or hex address`
      )
    })
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

/** The address inputs the storage-authority gate compares against. */
export interface IGateAddressInputs {
  deployments: Record<string, unknown>
  pinnedDeployments?: Record<string, unknown>
  globalConfig: Record<string, unknown>
}

/**
 * The gate's address inputs spelled as 20-byte hex on every network: on Tron the
 * deployments are converted from base58 and the wallets replaced by
 * `tronWallets`; on any other network the inputs are returned unchanged.
 *
 * A base58 entry that dropped out instead of converting would shrink the set of
 * addresses the gate recognises, so a failed conversion throws rather than
 * yielding a smaller set.
 *
 * @param network - Network name as it appears in `config/networks.json`.
 * @param inputs - Deployments, optional pinned deployments and the global config.
 * @returns The same inputs in the spelling the gate compares.
 * @throws When a Tron address fails to convert or `tronWallets` is incomplete.
 */
export const gateAddressInputsForNetwork = (
  network: string,
  inputs: IGateAddressInputs
): IGateAddressInputs => {
  if (!isTronNetworkKey(network)) return inputs
  return {
    deployments: tronDeploymentsAsHex(network, inputs.deployments),
    ...(inputs.pinnedDeployments
      ? {
          pinnedDeployments: tronDeploymentsAsHex(
            network,
            inputs.pinnedDeployments
          ),
        }
      : {}),
    globalConfig: withTronWallets(network, inputs.globalConfig),
  }
}
