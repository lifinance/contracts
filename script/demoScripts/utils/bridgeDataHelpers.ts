import { utils } from 'ethers'

import { type ILiFi } from '../../../typechain'

/**
 * Creates a standardized bridgeData object for LiFi transactions
 * @param transactionId - Unique transaction identifier
 * @param bridge - Bridge protocol name (e.g., 'acrossV4', 'stargateV2')
 * @param integrator - Integrator identifier
 * @param referrer - Referrer address (usually zero address)
 * @param sendingAssetId - Source asset address
 * @param receiver - Destination receiver address
 * @param minAmount - Minimum amount to receive
 * @param destinationChainId - Target chain ID
 * @param hasSourceSwaps - Whether source swaps are included
 * @param hasDestinationCall - Whether destination calls are included
 * @returns Properly typed ILiFi.BridgeDataStruct
 */
export const createBridgeData = (
  transactionId: Uint8Array,
  bridge: string,
  integrator: string,
  referrer: string,
  sendingAssetId: string,
  receiver: string,
  minAmount: string,
  destinationChainId: number,
  hasSourceSwaps: boolean,
  hasDestinationCall: boolean
): ILiFi.BridgeDataStruct => {
  return {
    transactionId,
    bridge,
    integrator,
    referrer,
    sendingAssetId,
    receiver,
    minAmount,
    destinationChainId,
    hasSourceSwaps,
    hasDestinationCall,
  }
}

/**
 * Creates a default bridgeData object with common defaults
 * @param bridge - Bridge protocol name
 * @param sendingAssetId - Source asset address
 * @param receiver - Destination receiver address
 * @param minAmount - Minimum amount to receive
 * @param destinationChainId - Target chain ID
 * @param hasSourceSwaps - Whether source swaps are included
 * @param hasDestinationCall - Whether destination calls are included
 * @returns Properly typed ILiFi.BridgeDataStruct with defaults
 */
export const createDefaultBridgeData = (
  bridge: string,
  sendingAssetId: string,
  receiver: string,
  minAmount: string,
  destinationChainId: number,
  hasSourceSwaps = false,
  hasDestinationCall = false
): ILiFi.BridgeDataStruct => {
  return createBridgeData(
    utils.randomBytes(32),
    bridge,
    'demoScript',
    '0x0000000000000000000000000000000000000000',
    sendingAssetId,
    receiver,
    minAmount,
    destinationChainId,
    hasSourceSwaps,
    hasDestinationCall
  )
}

/**
 * Type alias for better readability in demo scripts
 */
export type BridgeData = ILiFi.BridgeDataStruct
