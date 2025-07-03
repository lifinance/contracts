import type networks from '../../config/networks.json'

export type SupportedChain = keyof typeof networks

export interface INetworksObject {
  [key: string]: Omit<INetwork, 'id'>
}

export enum IEnvironmentEnum {
  'staging',
  'production',
}

export interface INetwork {
  name: string
  chainId: number
  nativeAddress: string
  nativeCurrency: string
  wrappedNativeAddress: string
  status: string
  type: string
  rpcUrl: string
  verificationType: string
  explorerUrl: string
  explorerApiUrl: string
  multicallAddress: string
  safeAddress: string
  deployedWithEvmVersion: string
  deployedWithSolcVersion: string
  gasZipChainId: number
  id: string
  devNotes?: string
}
