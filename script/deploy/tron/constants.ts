/**
 * Tron-specific constants for the contracts repo.
 *
 * Shared constants (fee limits, energy pricing, safety margins, etc.) are provided by
 * @lifi/tron-devkit — import them from there directly rather than duplicating here.
 */

import * as path from 'path'
import { fileURLToPath } from 'url'

import { TRON_SCRIPT_FEE_LIMIT_50_TRX_SUN } from '@lifi/tron-devkit'
import type { Hex } from 'viem'

import type { SupportedChain } from '../../common/types'

const __tronConstantsDir = path.dirname(fileURLToPath(import.meta.url))

/** Base directory for Safe v1.4.1 Foundry artifacts (`safe/london/out`). */
export const TRON_SAFE_ARTIFACTS_BASE = path.join(
  __tronConstantsDir,
  '../../../safe/london/out'
)

/** Temp file for singleton/factory addresses during Safe deploy; */
export const TRON_SAFE_DEPLOY_TEMP_JSON_PATH = path.join(
  process.cwd(),
  'config',
  '.tron-safe-deploy-temp.json'
)

/** `networks.json` / config key for production Tron deployment scripts. */
export const TRON_DEPLOY_NETWORK: SupportedChain = 'tron'

/** Facet batches for split diamondCut registration (order matters). */
export const TRON_DIAMOND_FACET_GROUPS: string[][] = [
  ['DiamondLoupeFacet'],
  ['OwnershipFacet', 'WithdrawFacet', 'AccessManagerFacet'],
  ['WhitelistManagerFacet', 'PeripheryRegistryFacet'],
  ['GenericSwapFacetV3'],
  ['CalldataVerificationFacet', 'EmergencyPauseFacet'],
]

/** Topic0 for Safe `ProxyCreation` event (no `0x` prefix; lowercase hex). */
export const TRON_SAFE_PROXY_CREATION_TOPIC_HEX =
  '4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235' // [pre-commit-checker: not a secret]

/** Minimal ABI for `SafeProxyFactory.createProxyWithNonce`. */
export const TRON_SAFE_PROXY_FACTORY_ABI = [
  {
    inputs: [
      { internalType: 'address', name: '_singleton', type: 'address' },
      { internalType: 'bytes', name: 'initializer', type: 'bytes' },
      { internalType: 'uint256', name: 'saltNonce', type: 'uint256' },
    ],
    name: 'createProxyWithNonce',
    outputs: [{ internalType: 'address', name: 'proxy', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/** Minimal ABI for calling `setup` on a Safe proxy. */
export const TRON_SAFE_SETUP_ABI = [
  {
    inputs: [
      { internalType: 'address[]', name: '_owners', type: 'address[]' },
      { internalType: 'uint256', name: '_threshold', type: 'uint256' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'bytes', name: 'data', type: 'bytes' },
      { internalType: 'address', name: 'fallbackHandler', type: 'address' },
      { internalType: 'address', name: 'paymentToken', type: 'address' },
      { internalType: 'uint256', name: 'payment', type: 'uint256' },
      {
        internalType: 'address payable',
        name: 'paymentReceiver',
        type: 'address',
      },
    ],
    name: 'setup',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

export const TRON_DIAMOND_CONFIRM_OWNERSHIP_SELECTOR = '0x7200b829' as Hex

/** Minimal ABI fragment for Safe `getTransactionHash`. */
export const TRON_SAFE_GET_TX_HASH_ABI = [
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    name: 'getTransactionHash',
    outputs: [{ type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// Diamond operations require significantly more energy than regular transactions
export const DIAMOND_CUT_ENERGY_MULTIPLIER = 10

// Safety multiplier for Safe createProxyWithNonce + setup (proxy creation) energy estimate
export const CREATE_PROXY_SAFETY_MARGIN = 1.2

/** Min/max fee limit (SUN) for registerPeripheryContract prompts and bounds checks. */
export const REGISTER_PERIPHERY_FEE_LIMIT_MIN_SUN = 1_000_000 // 1 TRX
export const REGISTER_PERIPHERY_FEE_LIMIT_MAX_SUN =
  TRON_SCRIPT_FEE_LIMIT_50_TRX_SUN
