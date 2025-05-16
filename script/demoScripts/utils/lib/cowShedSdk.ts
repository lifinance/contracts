/**
 * CoW Shed SDK implementation using viem
 */
import {
  getCreate2Address,
  keccak256,
  concat,
  encodeAbiParameters,
  parseAbiParameters,
  hashTypedData,
  encodeFunctionData,
  Address,
} from 'viem'
import { FACTORY_ABI, PROXY_CREATION_CODE, SHED_ABI } from './cowShedConstants'
import { formatAddress } from './address'

export interface ISdkOptions {
  factoryAddress: string
  implementationAddress: string
  proxyCreationCode?: string
  chainId: number
}

export interface ICall {
  target: string
  value: bigint
  callData: string
  allowFailure: boolean
  isDelegateCall: boolean
}

export class CowShedSdk {
  private factoryAddress: string
  private implementationAddress: string
  private proxyCreationCode: string
  private chainId: number

  constructor(options: ISdkOptions) {
    this.factoryAddress = options.factoryAddress
    this.implementationAddress = options.implementationAddress
    this.proxyCreationCode = options.proxyCreationCode || PROXY_CREATION_CODE
    this.chainId = options.chainId
  }

  computeProxyAddress(user: string): string {
    // Format addresses to ensure they're valid
    const formattedFactoryAddress = formatAddress(this.factoryAddress)
    const formattedImplementationAddress = formatAddress(this.implementationAddress)
    const formattedUserAddress = formatAddress(user)
    
    // Create the salt from the user address
    const salt = encodeAbiParameters(
      parseAbiParameters('address'),
      [formattedUserAddress]
    )
    
    // Create the init code by concatenating the proxy creation code and the encoded constructor arguments
    const initCode = concat([
      this.proxyCreationCode as `0x${string}`,
      encodeAbiParameters(
        parseAbiParameters('address, address'),
        [formattedImplementationAddress, formattedUserAddress]
      )
    ])
    
    // Calculate the init code hash
    const initCodeHash = keccak256(initCode)
    
    // Calculate the CREATE2 address
    const proxyAddress = getCreate2Address({
      from: formattedFactoryAddress,
      salt: salt,
      bytecodeHash: initCodeHash,
    })
    
    return proxyAddress
  }

  hashToSignWithUser(
    calls: ICall[],
    nonce: `0x${string}`,
    deadline: bigint,
    user: string
  ): `0x${string}` {
    const proxy = this.computeProxyAddress(user)
    return this.hashToSign(calls, nonce, deadline, proxy)
  }

  private hashToSign(
    calls: ICall[],
    nonce: `0x${string}`,
    deadline: bigint,
    proxy: string
  ): `0x${string}` {
    const domain = {
      name: 'COWShed',
      version: '1.0.0',
      chainId: this.chainId,
      verifyingContract: proxy as `0x${string}`,
    }

    const types = {
      ExecuteHooks: [
        { name: 'calls', type: 'Call[]' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
      ],
      Call: [
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'callData', type: 'bytes' },
        { name: 'allowFailure', type: 'bool' },
        { name: 'isDelegateCall', type: 'bool' },
      ],
    }

    const message = {
      calls: calls.map((call) => ({
        target: call.target as `0x${string}`,
        value: call.value,
        callData: call.callData as `0x${string}`,
        allowFailure: call.allowFailure,
        isDelegateCall: call.isDelegateCall,
      })),
      nonce,
      deadline,
    }

    return hashTypedData({
      domain,
      types,
      primaryType: 'ExecuteHooks',
      message,
    })
  }

  static encodeExecuteHooksForFactory(
    calls: ICall[],
    nonce: `0x${string}`,
    deadline: bigint,
    user: string,
    signature: `0x${string}`
  ): string {
    // Format the user address
    const formattedUser = formatAddress(user)
    
    // Convert calls to the expected format for the ABI
    const formattedCalls = calls.map(call => [
      formatAddress(call.target),
      call.value,
      call.callData as `0x${string}`,
      call.allowFailure,
      call.isDelegateCall
    ] as const)
    
    return encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: 'executeHooks',
      args: [
        formattedCalls,
        nonce,
        deadline,
        formattedUser,
        signature,
      ],
    })
  }
}