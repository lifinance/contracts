import {
  parseAbi,
  encodeFunctionData,
  recoverMessageAddress,
  keccak256,
  encodePacked,
  pad,
  getAddress,
} from 'viem'
import { randomBytes } from 'crypto'
import { ethers } from 'ethers'
import { COW_SHED_FACTORY, COW_SHED_IMPLEMENTATION } from '@cowprotocol/cow-sdk'
import { consola } from 'consola'
import {
  generateNeedle,
  findNeedleOffset,
  generateExecuteWithDynamicPatchesCalldata,
  generateBalanceOfCalldata,
} from './patcherHelpers'

// EIP-1967 transparent proxy creation bytecode for CowShed user proxies
// This bytecode creates a minimal proxy that delegates calls to the CowShed implementation
// while storing the implementation address in the standard EIP-1967 storage slot
const PROXY_CREATION_CODE =
  '0x60a034608e57601f61037138819003918201601f19168301916001600160401b038311848410176093578084926040948552833981010312608e57604b602060458360a9565b920160a9565b6080527f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc556040516102b490816100bd8239608051818181608f01526101720152f35b600080fd5b634e487b7160e01b600052604160045260246000fd5b51906001600160a01b0382168203608e5756fe60806040526004361015610018575b3661019457610194565b6000803560e01c908163025b22bc1461003b575063f851a4400361000e5761010d565b3461010a5760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261010a5773ffffffffffffffffffffffffffffffffffffffff60043581811691828203610106577f0000000000000000000000000000000000000000000000000000000000000000163314600014610101577f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc557fbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b8280a280f35b61023d565b8380fd5b80fd5b346101645760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610164576020610146610169565b73ffffffffffffffffffffffffffffffffffffffff60405191168152f35b600080fd5b333003610101577f000000000000000000000000000000000000000000000000000000000000000090565b60ff7f68df44b1011761f481358c0f49a711192727fb02c377d697bcb0ea8ff8393ac0541615806101ef575b1561023d5760046040517ff92ee8a9000000000000000000000000000000000000000000000000000000008152fd5b507f400ada75000000000000000000000000000000000000000000000000000000007fffffffff000000000000000000000000000000000000000000000000000000006000351614156101c0565b7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc546000808092368280378136915af43d82803e1561027a573d90f35b3d90fdfea2646970667358221220c7c26ff3040b96a28e96d6d27b743972943aeaef81cc821544c5fe1e24f9b17264736f6c63430008190033'

/**
 * Compute the deterministic proxy address for a CowShed user
 */
export function computeCowShedProxyAddress(
  factoryAddress: string,
  implementationAddress: string,
  owner: string
): `0x${string}` {
  const salt = ethers.utils.defaultAbiCoder.encode(['address'], [owner])
  const initCodeHash = ethers.utils.solidityKeccak256(
    ['bytes', 'bytes'],
    [
      PROXY_CREATION_CODE,
      ethers.utils.defaultAbiCoder.encode(
        ['address', 'address'],
        [implementationAddress, owner]
      ),
    ]
  )
  return ethers.utils.getCreate2Address(
    factoryAddress,
    salt,
    initCodeHash
  ) as `0x${string}`
}

/**
 * Encode the executeHooks call for the CowShed factory
 */
export function encodeCowShedExecuteHooks(
  calls: any[],
  nonce: `0x${string}`,
  deadline: bigint,
  owner: `0x${string}`,
  signature: `0x${string}`
): string {
  const cowShedFactoryAbi = parseAbi([
    'function executeHooks((address target, uint256 value, bytes callData, bool allowFailure, bool isDelegateCall)[] calls, bytes32 nonce, uint256 deadline, address user, bytes signature) returns (address proxy)',
  ])

  return encodeFunctionData({
    abi: cowShedFactoryAbi,
    functionName: 'executeHooks',
    args: [
      calls.map((call) => ({
        target: getAddress(call.target),
        value: call.value,
        callData: call.callData,
        allowFailure: call.allowFailure,
        isDelegateCall: call.isDelegateCall,
      })),
      nonce,
      deadline,
      owner,
      signature,
    ],
  })
}

export interface ICowShedPostHooksConfig {
  chainId: number
  walletClient: any
  usdcAddress: string
  receivedAmount: bigint
  lifiDiamondAddress: string
  patcherAddress: string
  baseUsdcAddress: string
  destinationChainId: bigint
}

/**
 * Setup CowShed post hooks for bridging USDC to BASE using Relay
 */
export async function setupCowShedPostHooks(config: ICowShedPostHooksConfig) {
  const {
    chainId,
    walletClient,
    usdcAddress,
    receivedAmount,
    lifiDiamondAddress,
    patcherAddress,
    baseUsdcAddress,
    destinationChainId,
  } = config

  const account = walletClient.account
  const signerAddress = account.address

  // Generate a random nonce
  const nonce = `0x${Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')}` as `0x${string}`

  // Set a deadline 24 hours from now
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60)

  // Get the proxy address
  const shedDeterministicAddress = computeCowShedProxyAddress(
    COW_SHED_FACTORY,
    COW_SHED_IMPLEMENTATION,
    signerAddress
  )
  consola.info(`CowShed proxy address: ${shedDeterministicAddress}`)

  // Create the bridge data for LiFi
  const bridgeData = {
    transactionId: `0x${randomBytes(32).toString('hex')}` as `0x${string}`,
    bridge: 'relay',
    integrator: 'TestIntegrator',
    referrer: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    sendingAssetId: usdcAddress as `0x${string}`,
    receiver: signerAddress as `0x${string}`,
    minAmount: receivedAmount,
    destinationChainId,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  // Create RelayData
  // First, create a quote request with a realistic amount
  const estimatedUsdcAmount = '1000000' // 1 USDC (6 decimals)

  // Get a real signature from the Relay API
  // First, create a quote request
  // Use LiFi Diamond as the user since it will be the final caller of RelayFacet
  const quoteParams = {
    user: lifiDiamondAddress, // LiFi Diamond will be address(this) in RelayFacet
    originChainId: chainId,
    destinationChainId: Number(destinationChainId),
    originCurrency: usdcAddress,
    destinationCurrency: baseUsdcAddress,
    recipient: signerAddress,
    tradeType: 'EXACT_INPUT',
    amount: estimatedUsdcAmount, // Use a realistic amount instead of 0
    referrer: 'lifi-demo',
    useExternalLiquidity: false,
  }

  // Fetch the quote from the Relay API
  consola.info('Fetching quote from Relay API...')
  const quoteResponse = await fetch('https://api.relay.link/quote', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(quoteParams),
  })

  if (!quoteResponse.ok) {
    throw new Error(
      `Failed to get quote from Relay API: ${quoteResponse.statusText}`
    )
  }

  const quoteData = await quoteResponse.json()
  const relayRequestId = quoteData.steps[0].requestId
  consola.info(`Got requestId from Relay API: ${relayRequestId}`)

  // Fetch the signature from the Relay API
  consola.info('Fetching signature from Relay API...')
  const signatureResponse = await fetch(
    `https://api.relay.link/requests/${relayRequestId}/signature/v2`,
    { headers: { 'Content-Type': 'application/json' } }
  )

  if (!signatureResponse.ok) {
    throw new Error(
      `Failed to get signature from Relay API: ${signatureResponse.statusText}`
    )
  }

  const signatureData = await signatureResponse.json()
  const relaySignature = signatureData.signature as `0x${string}`
  consola.info(
    `Got signature from Relay API: ${relaySignature.slice(
      0,
      10
    )}...${relaySignature.slice(-8)}`
  )

  // Log the request origin user (not the signer)
  if (signatureData.requestData?.originUser) {
    const originUser = signatureData.requestData.originUser
    consola.info(`Request origin user: ${originUser} (LiFi Diamond)`)
  }

  // Optional signature verification for debugging purposes
  // This code verifies that the signature from Relay API is valid by recovering the signer
  // It's not required for functionality but helps ensure the signature is working correctly
  // Recover the actual signer using the same message format as the contract
  try {
    // Construct the message exactly as the contract does:
    // Use viem's encodePacked instead of manual concatenation
    const packedData = encodePacked(
      [
        'bytes32',
        'uint256',
        'bytes32',
        'bytes32',
        'uint256',
        'bytes32',
        'bytes32',
      ],
      [
        relayRequestId as `0x${string}`, // requestId
        BigInt(chainId), // chainId
        pad(lifiDiamondAddress as `0x${string}`), // LiFi Diamond address as bytes32 (address(this) in RelayFacet)
        pad(usdcAddress as `0x${string}`), // sendingAssetId as bytes32
        destinationChainId, // destinationChainId
        pad(signerAddress as `0x${string}`), // receiver as bytes32
        pad(baseUsdcAddress as `0x${string}`), // receivingAssetId as bytes32
      ]
    )

    // Hash the packed data
    const messageHash = keccak256(packedData)

    // Recover the signer using the message hash (Ethereum signed message format)
    const recoveredSigner = await recoverMessageAddress({
      message: { raw: messageHash },
      signature: relaySignature,
    })

    consola.success(`Relay attestation signer: ${recoveredSigner}`)
  } catch (error) {
    consola.warn('Could not recover signer address:', error)
    // Fallback: log full response for debugging
    consola.debug(
      'Full signature response:',
      JSON.stringify(signatureData, null, 2)
    )
  }

  const relayData = {
    requestId: relayRequestId,
    nonEVMReceiver:
      '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`, // Not bridging to non-EVM chain
    receivingAssetId: pad(baseUsdcAddress as `0x${string}`), // Use viem's pad instead of manual padStart
    signature: relaySignature, // Real signature from the Relay API
  }

  // Encode the RelayFacet call
  const relayFacetAbi = parseAbi([
    'function startBridgeTokensViaRelay((bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall) _bridgeData, (bytes32 requestId, bytes32 nonEVMReceiver, bytes32 receivingAssetId, bytes signature) _relayData) payable',
  ])

  // Create the bridge data with proper types
  const typedBridgeData = {
    transactionId: bridgeData.transactionId,
    bridge: bridgeData.bridge,
    integrator: bridgeData.integrator,
    referrer: bridgeData.referrer,
    sendingAssetId: bridgeData.sendingAssetId,
    receiver: bridgeData.receiver,
    destinationChainId: bridgeData.destinationChainId,
    minAmount: bridgeData.minAmount,
    hasSourceSwaps: bridgeData.hasSourceSwaps,
    hasDestinationCall: bridgeData.hasDestinationCall,
  }

  // Create the relay data with proper types
  const typedRelayData = {
    requestId: relayData.requestId,
    nonEVMReceiver: relayData.nonEVMReceiver,
    receivingAssetId: relayData.receivingAssetId,
    signature: relayData.signature,
  }

  // Generate a random bytes32 hex value as needle to find the minAmount position
  const minAmountNeedle = generateNeedle()

  // Create calldata with the needle in place of minAmount (will be patched by Patcher)
  const bridgeDataWithNeedle = {
    ...typedBridgeData,
    minAmount: minAmountNeedle, // Pass as hex string directly
  }

  const relayCalldata = encodeFunctionData({
    abi: relayFacetAbi,
    functionName: 'startBridgeTokensViaRelay',
    args: [bridgeDataWithNeedle as any, typedRelayData],
  })

  // Find the needle position in the calldata
  const minAmountOffset = findNeedleOffset(relayCalldata, minAmountNeedle)
  consola.info(
    `Found minAmount offset using dynamic search: ${minAmountOffset} bytes`
  )

  // Note: This offset is specifically for startBridgeTokensViaRelay function
  // Different bridge functions may have different offsets due to different parameter layouts

  // Encode the balanceOf call to get the USDC balance
  const valueGetter = generateBalanceOfCalldata(shedDeterministicAddress)

  // Encode the patcher call
  const patcherCalldata = generateExecuteWithDynamicPatchesCalldata(
    usdcAddress as `0x${string}`, // valueSource - USDC contract
    valueGetter, // valueGetter - balanceOf call
    lifiDiamondAddress as `0x${string}`, // finalTarget - LiFiDiamond contract
    relayCalldata as `0x${string}`, // data - the encoded RelayFacet call
    [minAmountOffset], // offsets - Array with position of minAmount in the calldata
    0n, // value - no ETH being sent
    false // delegateCall
  )

  // Encode the USDC approval call for the DIAMOND address
  const approvalCalldata = encodeFunctionData({
    abi: parseAbi([
      'function approve(address spender, uint256 amount) returns (bool)',
    ]),
    functionName: 'approve',
    args: [
      lifiDiamondAddress as `0x${string}`, // spender - LiFi Diamond
      BigInt(
        '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      ), // Max uint256 approval
    ],
  })

  // Define the post-swap calls: first approval, then bridge
  const postSwapCalls = [
    {
      target: usdcAddress as `0x${string}`,
      callData: approvalCalldata,
      value: 0n,
      allowFailure: false,
      isDelegateCall: false,
    },
    {
      target: patcherAddress as `0x${string}`,
      callData: patcherCalldata,
      value: 0n,
      allowFailure: false,
      isDelegateCall: true,
    },
  ]

  // Create the typed data for the hooks
  const typedData = {
    account,
    domain: {
      name: 'COWShed',
      version: '1.0.0',
      chainId: BigInt(chainId),
      verifyingContract: shedDeterministicAddress,
    },
    types: {
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
    },
    primaryType: 'ExecuteHooks',
    message: {
      calls: postSwapCalls.map((call) => ({
        target: call.target,
        value: call.value,
        callData: call.callData,
        allowFailure: call.allowFailure,
        isDelegateCall: call.isDelegateCall,
      })),
      nonce,
      deadline,
    },
  }

  // Sign the typed data for the hooks
  const hookSignature = (await walletClient.signTypedData(
    typedData
  )) as `0x${string}`

  // Encode the post hooks call data
  const shedEncodedPostHooksCallData = encodeCowShedExecuteHooks(
    postSwapCalls,
    nonce,
    deadline,
    signerAddress as `0x${string}`,
    hookSignature
  )

  // Create the post hooks
  const postHooks = [
    {
      target: COW_SHED_FACTORY,
      callData: shedEncodedPostHooksCallData,
      gasLimit: '3000000',
    },
  ]

  return {
    shedDeterministicAddress,
    postHooks,
  }
}
