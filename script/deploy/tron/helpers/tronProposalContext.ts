/**
 * Shared setup for Tron Safe → Timelock proposal scripts.
 *
 * Both `propose-facet-update.ts` and `propose-periphery-registration.ts`
 * (and any future per-item Tron proposer) need the same boilerplate:
 *   - Resolve `PRODUCTION` env to the network key (`tron` vs `tronshasta`).
 *   - Load the deployment log and validate the Diamond entry.
 *   - Build a read-only TronWeb instance with a placeholder defaultAddress
 *     so `.call()` on view methods doesn't fail with "owner_address isn't set".
 *   - Submit the encoded calldata via `propose-to-safe-tron`'s `runPropose`
 *     with `timelock: true` (Safe → Timelock.scheduleBatch → target).
 *
 * Keeping these in one place avoids drift between proposer scripts.
 */

import * as fs from 'fs'
import * as path from 'path'

import {
  createTronWebReadOnly,
  getTronRPCConfig,
  tronZeroAddressBase58,
  type TronTvmNetworkName,
} from '@lifi/tron-devkit'
import type { TronWeb } from 'tronweb'
import type { Hex } from 'viem'

import { EnvironmentEnum } from '../../../common/types'
import { getEnvironment } from '../../../utils/utils'

export interface ITronProposalContext {
  /** Network key as it appears in `config/networks.json` and deployments file. */
  networkName: TronTvmNetworkName
  /** Tron base58 form of the LiFiDiamond contract. */
  diamondAddressBase58: string
  /** Parsed `deployments/<network>.json` contents. */
  deployments: Record<string, string>
  /** Read-only TronWeb instance with a placeholder defaultAddress set. */
  readTronWeb: TronWeb
}

/**
 * Resolves the env-derived network, deployment log, and a read-only TronWeb
 * for proposal scripts. Throws when `deployments/<network>.json` is missing
 * or has no `LiFiDiamond` entry.
 */
export function getTronProposalContext(): ITronProposalContext {
  const environment = getEnvironment()
  const networkName: TronTvmNetworkName =
    environment === EnvironmentEnum.production ? 'tron' : 'tronshasta'

  const deploymentPath = path.join(
    process.cwd(),
    'deployments',
    `${networkName}.json`
  )
  if (!fs.existsSync(deploymentPath))
    throw new Error(`deployments/${networkName}.json not found`)
  const deployments = JSON.parse(
    fs.readFileSync(deploymentPath, 'utf8')
  ) as Record<string, string>

  const diamondAddressBase58 = deployments.LiFiDiamond
  if (!diamondAddressBase58)
    throw new Error(`LiFiDiamond missing in deployments/${networkName}.json`)

  const { rpcUrl, headers } = getTronRPCConfig(networkName, false)
  const readTronWeb = createTronWebReadOnly({ rpcUrl, headers })
  // TronWeb requires defaultAddress for `.call()` even on view methods —
  // see readDiamondFacets / readCurrentRegistration usage in callers.
  if (!readTronWeb.defaultAddress.base58)
    readTronWeb.setAddress(tronZeroAddressBase58(readTronWeb))

  return { networkName, diamondAddressBase58, deployments, readTronWeb }
}

/**
 * Submits one Safe → Timelock proposal for the given calldata.
 *
 * Thin wrapper around `runPropose` in `propose-to-safe-tron.ts` — locks in
 * `timelock: true` (Safe calls `Timelock.scheduleBatch(target, calldata)`)
 * and lets the caller flow `dryRun` through.
 *
 * Lazy-imports `propose-to-safe-tron` so a `--dryRun` invocation that ends
 * up needing no proposals doesn't pull in MongoDB/TronWeb signing code.
 */
export async function proposeViaTimelock(opts: {
  networkName: TronTvmNetworkName
  diamondAddressBase58: string
  calldata: Hex
  dryRun: boolean
}): Promise<void> {
  const { runPropose } = await import('../propose-to-safe-tron')
  await runPropose({
    network: opts.networkName,
    to: opts.diamondAddressBase58,
    calldata: opts.calldata,
    timelock: true,
    dryRun: opts.dryRun,
  })
}
