/**
 * Chain-agnostic helper for proposing periphery registrations via
 * Safe → Timelock.
 *
 * For each contract: reads the current `PeripheryRegistryFacet
 * .getPeripheryContract(name)` value, skips when already pointing at the new
 * address, otherwise encodes `registerPeripheryContract(name, address)` and
 * submits one proposal per contract.
 *
 * Dispatches on `isTronNetworkKey(network)`:
 *   - **Tron**: TronWeb-based view read + `propose-to-safe-tron`. Tron-specific
 *     modules are loaded via dynamic `await import()` so EVM-only consumers
 *     don't pull TronWeb into their bundle.
 *   - **EVM**: not implemented in TS. For EVM, the existing
 *     `propose-to-safe.ts --timelock` flow is the established path; this
 *     branch throws with a pointer, preserving the chain-agnostic API
 *     contract for future TS-side EVM use.
 */

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

const PERIPHERY_REGISTRY_ABI = parseAbi([
  'function registerPeripheryContract(string _name, address _contractAddress)',
])

/**
 * Plans `registerPeripheryContract(name, address)` proposals for the given
 * contracts and submits one Safe → Timelock transaction per contract.
 * Returns silently when every contract is already registered correctly.
 *
 * @param options.network        Target network key. Chain dispatch is decided
 *                               by `isTronNetworkKey(network)`.
 * @param options.contractNames  Periphery contract names to register.
 *                               Addresses are resolved from
 *                               `deployments/<network>.json`.
 * @param options.dryRun         When true, prints the planned proposals but
 *                               does not write to MongoDB.
 * @throws on missing deployments file, missing contract entries, EVM
 *   dispatch (not yet implemented), or any underlying TronWeb /
 *   propose-to-safe error.
 */
export async function planAndProposePeripheryRegistration(options: {
  network: string
  contractNames: string[]
  dryRun?: boolean
}): Promise<void> {
  if (isTronNetworkKey(options.network))
    return planAndProposePeripheryRegistrationForTron(options)
  throw new Error(
    `planAndProposePeripheryRegistration: EVM TS-side proposing not yet ` +
      `implemented. For EVM networks, encode ` +
      `registerPeripheryContract(name, address) and submit via ` +
      `script/deploy/safe/propose-to-safe.ts --timelock directly.`
  )
}

/**
 * Reads the current registered periphery address from the Diamond via
 * TronWeb. Returns the EVM-20 hex form (lowercase, `0x…`) or `null` when
 * the slot is unregistered (zero address) or the call fails (treated as
 * unregistered).
 */
async function readCurrentRegistrationTron(
  tronWeb: TronWeb,
  diamondAddressBase58: string,
  contractName: string,
  zeroAddressHex: string,
  toBase58: (raw: string) => string,
  toEvmHex: (base58: string) => Address
): Promise<Address | null> {
  const viewAbi = [
    {
      inputs: [{ name: '_name', type: 'string' }],
      name: 'getPeripheryContract',
      outputs: [{ name: '', type: 'address' }],
      stateMutability: 'view',
      type: 'function',
    },
  ]
  const diamond = tronWeb.contract(
    viewAbi as unknown as Parameters<typeof tronWeb.contract>[0],
    diamondAddressBase58
  )

  try {
    const raw = (await diamond.getPeripheryContract(contractName).call()) as
      | string
      | undefined
    if (!raw) return null
    if (raw === zeroAddressHex) return null
    return toEvmHex(toBase58(raw))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    consola.warn(
      `readCurrentRegistration(${contractName}): call failed (${message}); ` +
        `treating as unregistered`
    )
    return null
  }
}

async function planAndProposePeripheryRegistrationForTron(options: {
  network: string
  contractNames: string[]
  dryRun?: boolean
}): Promise<void> {
  const { contractNames, dryRun = false } = options
  if (contractNames.length === 0)
    throw new Error(
      'planAndProposePeripheryRegistration: at least one contract required'
    )

  // Dynamic imports keep TronWeb / Tron helpers out of EVM-only consumers.
  const { TRON_ZERO_ADDRESS, tronAddressLikeToBase58, tronAddressToHex } =
    await import('@lifi/tron-devkit')
  const { getTronProposalContext, proposeViaTimelock } = await import(
    '../tron/helpers/tronProposalContext'
  )

  const { networkName, diamondAddressBase58, deployments, readTronWeb } =
    getTronProposalContext(
      options.network as Parameters<typeof getTronProposalContext>[0]
    )

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

    const currentHex = await readCurrentRegistrationTron(
      readTronWeb,
      diamondAddressBase58,
      name,
      TRON_ZERO_ADDRESS,
      (raw) => tronAddressLikeToBase58(readTronWeb, raw),
      (base58) => tronAddressToHex(readTronWeb, base58) as Address
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
