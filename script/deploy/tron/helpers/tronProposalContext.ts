/**
 * Tron-specific I/O for the chain-agnostic propose helpers in
 * `script/deploy/shared/propose-{diamond-cut,periphery-registration}.ts`.
 * Those dispatchers route Tron via dynamic `await import()` of this module
 * (and of `tronUtils.readDiamondFacets`) so EVM-only consumers do not pull
 * TronWeb into their bundle.
 *
 * Provides:
 *   - `getTronProposalContext(networkName?)`: resolves the deployment log
 *     and a read-only TronWeb (with placeholder defaultAddress so `.call()`
 *     on view methods does not fail with "owner_address isn't set"). When
 *     `networkName` is omitted, falls back to `PRODUCTION`-env detection so
 *     standalone callers keep working.
 *   - `proposeViaTimelock(...)`: thin wrapper around `runPropose` from
 *     `propose-to-safe-tron.ts` that locks in `timelock: true` (Safe calls
 *     `Timelock.scheduleBatch(target, calldata)`).
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
 * Resolves the deployment log and a read-only TronWeb for proposal scripts.
 *
 * @param networkName  Optional override. When omitted, derives from the
 *                     `PRODUCTION` env (`tron` vs `tronshasta`) — preserves
 *                     standalone-call behaviour. The chain-agnostic dispatcher
 *                     in `script/deploy/shared/propose-diamond-cut.ts` passes
 *                     the network explicitly so the routed network and the
 *                     loaded deployment log cannot drift.
 * @throws when `deployments/<networkName>.json` is missing or has no
 *   `LiFiDiamond` entry.
 */
export function getTronProposalContext(
  networkName?: TronTvmNetworkName
): ITronProposalContext {
  if (!networkName) {
    const environment = getEnvironment()
    networkName =
      environment === EnvironmentEnum.production ? 'tron' : 'tronshasta'
  }

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
