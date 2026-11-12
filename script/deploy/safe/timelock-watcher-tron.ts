/**
 * Tron spellings for the timelock watcher: main names Tron contracts and wallets
 * in base58, while the chain's logs, its reads and every watcher check compare
 * 20-byte hex. Imported by the watcher when it watches a Tron network.
 */

import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'

const isBase58 = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('T')

/**
 * A deployments file with every base58 address spelled as hex.
 *
 * @param network - Tron network name.
 * @param deployments - Main's parsed `deployments/<network>.json`.
 * @returns A copy whose base58 addresses are checksummed hex; other values unchanged.
 * @throws When a base58 value is not a valid Tron address.
 */
export const tronDeploymentsAsHex = (
  network: string,
  deployments: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(deployments).map(([name, value]) => [
      name,
      isBase58(value) ? normalizeAddressForNetwork(network, value) : value,
    ])
  )

/**
 * The global config with its `tronWallets` laid over the EVM wallets of the
 * same name, in hex, since Tron's refund, pauser and withdraw wallets differ.
 *
 * @param network - Tron network name.
 * @param globalConfig - Parsed `config/global.json`.
 * @returns A copy whose wallet keys hold the Tron wallets in hex.
 * @throws When the config has no `tronWallets`, or one is not a valid Tron address.
 */
export const withTronWallets = (
  network: string,
  globalConfig: Record<string, unknown>
): Record<string, unknown> => {
  const wallets = globalConfig['tronWallets']
  if (typeof wallets !== 'object' || wallets === null)
    throw new Error('config/global.json has no tronWallets')
  const overlay: Record<string, string> = {}
  for (const [name, value] of Object.entries(wallets))
    if (isBase58(value))
      overlay[name] = normalizeAddressForNetwork(network, value)
  return { ...globalConfig, ...overlay }
}
