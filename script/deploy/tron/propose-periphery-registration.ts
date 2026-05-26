/**
 * Helper for proposing Tron periphery registrations via Safe → Timelock.
 *
 * Exports `planAndProposePeripheryRegistration`, called by
 * `deploy-and-register-periphery.ts` on the production branch (Diamond owner
 * = Timelock). For staging/testnet (deployer-owned), the deploy script uses
 * its existing direct-register path.
 *
 * For each contract name:
 *   - Resolves the new address from `deployments/<network>.json`.
 *   - Reads the current registration via
 *     `PeripheryRegistryFacet.getPeripheryContract(name)`.
 *   - Skips if already registered at the same address.
 *   - Otherwise encodes `registerPeripheryContract(name, address)` and
 *     creates one Safe → Timelock proposal per contract.
 */

import {
  TRON_ZERO_ADDRESS,
  tronAddressLikeToBase58,
  tronAddressToHex,
} from '@lifi/tron-devkit'
import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

import {
  getTronProposalContext,
  proposeViaTimelock,
} from './helpers/tronProposalContext'

const PERIPHERY_REGISTRY_ABI = parseAbi([
  'function registerPeripheryContract(string _name, address _contractAddress)',
])

/**
 * Reads the current registered periphery address from the Diamond.
 * Returns the EVM-20 hex form (lowercase, `0x…`) or `null` when the slot is
 * unregistered (zero address) or the call fails (treated as unregistered).
 */
async function readCurrentRegistration(
  tronWeb: TronWeb,
  diamondAddressBase58: string,
  contractName: string
): Promise<Address | null> {
  // PeripheryRegistryFacet ABI subset, used solely for the view read here.
  const viewAbi = [
    {
      inputs: [{ name: '_name', type: 'string' }],
      name: 'getPeripheryContract',
      outputs: [{ name: '', type: 'address' }],
      stateMutability: 'view',
      type: 'function',
    },
  ]
  // TronWeb's narrower AbiFragment type; cast to satisfy the runtime call.
  const diamond = tronWeb.contract(
    viewAbi as unknown as Parameters<typeof tronWeb.contract>[0],
    diamondAddressBase58
  )

  try {
    const raw = (await diamond.getPeripheryContract(contractName).call()) as
      | string
      | undefined
    if (!raw) return null
    if (raw === TRON_ZERO_ADDRESS) return null
    const base58 = tronAddressLikeToBase58(tronWeb, raw)
    return tronAddressToHex(tronWeb, base58) as Address
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    consola.warn(
      `readCurrentRegistration(${contractName}): call failed (${message}); ` +
        `treating as unregistered`
    )
    return null
  }
}

/**
 * Plans `registerPeripheryContract(name, address)` proposals for the given
 * contracts and submits one Safe → Timelock proposal per contract.
 *
 * Reused by the CLI (interactive) and by `deploy-and-register-periphery.ts`
 * (after deploys on Timelock-owned diamonds). Returns silently when every
 * contract is already registered at the right address.
 *
 * @throws if no contracts given, deployments file missing, or any contract
 *   has no entry in `deployments/<network>.json`.
 */
export async function planAndProposePeripheryRegistration(options: {
  contractNames: string[]
  dryRun?: boolean
}): Promise<void> {
  const { contractNames, dryRun = false } = options
  if (contractNames.length === 0)
    throw new Error(
      'planAndProposePeripheryRegistration: at least one contract required'
    )

  const { networkName, diamondAddressBase58, deployments, readTronWeb } =
    getTronProposalContext()

  consola.info(`Network: ${networkName}`)
  consola.info(`Diamond: ${diamondAddressBase58}`)
  consola.info(`Contracts to plan: ${contractNames.join(', ')}`)

  let proposed = 0
  let skipped = 0
  for (const name of contractNames) {
    const newAddressBase58 = deployments[name]
    if (!newAddressBase58)
      throw new Error(
        `Contract ${name} not found in deployments/${networkName}.json`
      )

    const newAddressHex = tronAddressToHex(
      readTronWeb,
      newAddressBase58
    ) as Address

    const currentHex = await readCurrentRegistration(
      readTronWeb,
      diamondAddressBase58,
      name
    )

    if (
      currentHex &&
      currentHex.toLowerCase() === newAddressHex.toLowerCase()
    ) {
      consola.info(
        `  ✓ ${name} (${newAddressBase58}): already registered, skipping`
      )
      skipped++
      continue
    }

    const verb = currentHex ? 'Replace' : 'Add'
    const currentDisplay = currentHex
      ? tronAddressLikeToBase58(readTronWeb, currentHex)
      : '<none>'
    consola.info(
      `  → ${name}: ${verb} (current=${currentDisplay}, new=${newAddressBase58})`
    )

    const calldata: Hex = encodeFunctionData({
      abi: PERIPHERY_REGISTRY_ABI,
      functionName: 'registerPeripheryContract',
      args: [name, newAddressHex],
    })

    consola.info(
      `Encoded registerPeripheryContract calldata for ${name} ` +
        `(${calldata.length / 2} bytes)`
    )
    if (dryRun)
      consola.info(
        `--dryRun — proposal plan for ${name}:\n${JSON.stringify(
          {
            to: diamondAddressBase58,
            function: 'registerPeripheryContract',
            args: [name, newAddressHex],
          },
          null,
          2
        )}`
      )

    await proposeViaTimelock({
      networkName,
      diamondAddressBase58,
      calldata,
      dryRun,
    })
    proposed++
  }

  if (proposed === 0 && skipped === contractNames.length)
    consola.success(
      'No changes needed — every contract is already registered correctly.'
    )
  else
    consola.info(
      `Done — proposed ${proposed} periphery registration(s), ` +
        `skipped ${skipped} already-registered contract(s).`
    )
}
