  import { zeroAddress, Abi } from 'viem'
  import { randomBytes } from 'crypto'
  import { config } from 'dotenv'
  import {
    ensureBalance,
    executeTransaction,
    setupEnvironment,
  } from './utils/demoScriptHelpers'
  import type { UnitFacet, ILiFi } from '../../typechain'
  import unitFacetArtifact from '../../out/UnitFacet.sol/UnitFacet.json'
  import type { SupportedChain } from '../common/types'
  import { networks } from '../utils/viemScriptHelpers'

  config()

  interface IProposal {
    destinationAddress: string
    destinationChain: string
    asset: string
    address: string
    sourceChain: string
    coinType?: string
    keyType?: string
  }

  interface IVerificationResult {
    success: boolean | undefined
    verifiedCount: number | undefined
    errors?: string[] | undefined
    verificationDetails?: { [nodeId: string]: boolean } | undefined
  }

  function legacyProposalToPayload(
    nodeId: string,
    proposal: IProposal
  ): Uint8Array {
    const payloadString = `${nodeId}:${[
      proposal.destinationAddress,
      proposal.destinationChain,
      proposal.asset,
      proposal.address,
      proposal.sourceChain,
      'deposit',
    ].join('-')}`
    console.log('payloadString', payloadString)
    return new TextEncoder().encode(payloadString)
  }

  function newProposalToPayload(nodeId: string, proposal: IProposal): Uint8Array {
    console.log('nodeId', nodeId)
    console.log('proposal.coinType', proposal.coinType)
    console.log('proposal.destinationChain', proposal.destinationChain)
    console.log('proposal.destinationAddress', proposal.destinationAddress)
    console.log('proposal.address', proposal.address)
    const payloadString = `${nodeId}:${[
      'user',
      proposal.coinType,
      proposal.destinationChain,
      proposal.destinationAddress,
      proposal.address,
    ].join('-')}`
    return new TextEncoder().encode(payloadString)
  }

  function hexToBytes(hex: string): Uint8Array {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex
    return new Uint8Array(Buffer.from(cleanHex, 'hex'))
  }

  async function processGuardianNodes(
    nodes: { nodeId: string; publicKey: string }[]
  ) {
    const processed = []
    for (const node of nodes) {
      try {
        const publicKeyBytes = hexToBytes(node.publicKey)
        if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) {
          throw new Error(`Invalid public key format for node ${node.nodeId}`)
        }
        const publicKey = await crypto.subtle.importKey(
          'raw',
          new Uint8Array(publicKeyBytes),
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['verify']
        )
        processed.push({ nodeId: node.nodeId, publicKey })
      } catch (error) {
        console.error(`Failed to process node ${node.nodeId}:`, error)
        throw new Error(
          `Node processing failed: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      }
    }
    return processed
  }

  async function verifySignature(
    publicKey: CryptoKey,
    message: Uint8Array,
    signature: string
  ): Promise<boolean> {
    try {
      const sigBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0))
      if (sigBytes.length !== 64) {
        console.warn('Invalid signature length:', sigBytes.length)
        return false
      }

      return await crypto.subtle.verify(
        {
          name: 'ECDSA',
          hash: { name: 'SHA-256' },
        },
        publicKey,
        sigBytes,
        new Uint8Array(message)
      )
    } catch (error) {
      console.error('Signature verification failed:', error)
      return false
    }
  }

  export async function verifyDepositAddressSignatures(
    guardianNodes: { nodeId: string; publicKey: string }[],
    threshold: number,
    signatures: { [nodeId: string]: string },
    proposal: IProposal
  ): Promise<IVerificationResult> {
    try {
      const processedNodes = await processGuardianNodes(guardianNodes)
      let verifiedCount = 0
      const errors: string[] = []
      const verificationDetails: { [nodeId: string]: boolean } = {}

      await Promise.all(
        processedNodes.map(async (node) => {
          try {
            if (!signatures[node.nodeId]) {
              verificationDetails[node.nodeId] = false
              return
            }
            let isVerified = false

            if (proposal.coinType !== 'ethereum') {
              const legacyPayload = legacyProposalToPayload(node.nodeId, proposal)
              isVerified = await verifySignature(
                node.publicKey,
                legacyPayload,
                signatures[node.nodeId]
              )

              if (!isVerified) {
                const newPayload = newProposalToPayload(node.nodeId, proposal)
                isVerified = await verifySignature(
                  node.publicKey,
                  newPayload,
                  signatures[node.nodeId]
                )
              }
            } else {
              const payload = newProposalToPayload(node.nodeId, proposal)
              isVerified = await verifySignature(
                node.publicKey,
                payload,
                signatures[node.nodeId]
              )
            }

            verificationDetails[node.nodeId] = isVerified
            if (isVerified) verifiedCount++
          } catch (error) {
            errors.push(
              `Verification failed for node ${node.nodeId}: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`
            )
            verificationDetails[node.nodeId] = false
          }
        })
      )

      return {
        success: verifiedCount >= threshold,
        verifiedCount,
        errors: errors.length > 0 ? errors : undefined,
        verificationDetails,
      }
    } catch (error) {
      return {
        success: false,
        verifiedCount: 0,
        errors: [
          `Global verification error: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        ],
        verificationDetails: {},
      }
    }
  }

  async function main() {
    const GUARDIAN_SIGNATURE_THRESHOLD = 2

    const GUARDIAN_NODES = [
      {
        nodeId: 'unit-node',
        publicKey:
          '04dc6f89f921dc816aa69b687be1fcc3cc1d48912629abc2c9964e807422e1047e0435cb5ba0fa53cb9a57a9c610b4e872a0a2caedda78c4f85ebafcca93524061',
      },
      {
        nodeId: 'hl-node',
        publicKey:
          '048633ea6ab7e40cdacf37d1340057e84bb9810de0687af78d031e9b07b65ad4ab379180ab55075f5c2ebb96dab30d2c2fab49d5635845327b6a3c27d20ba4755b',
      },
      {
        nodeId: 'field-node',
        publicKey:
          '04ae2ab20787f816ea5d13f36c4c4f7e196e29e867086f3ce818abb73077a237f841b33ada5be71b83f4af29f333dedc5411ca4016bd52ab657db2896ef374ce99',
      },
    ]
    const srcChain: SupportedChain = 'plasma'
    const asset = 'xpl'
    const destinationChain = 'hyperliquid'
    const destinationAddress = '0x2b2c52B1b63c4BfC7F1A310a1734641D8e34De62'
    const sourceChainForRequest = (srcChain as string) === 'mainnet' ? 'ethereum' : srcChain
    const response = await fetch(
      `https://api.hyperunit.xyz/gen/${sourceChainForRequest}/${destinationChain}/${asset}/${destinationAddress}`,
      { headers: { 'Content-Type': 'application/json' } }
    )
    const responseJson = await response.json()
    const depositAddress: string = responseJson.address || ''
    console.log('Response JSON:', responseJson)
    console.log('Deposit address:', depositAddress)

    const result = await verifyDepositAddressSignatures(
      GUARDIAN_NODES,
      GUARDIAN_SIGNATURE_THRESHOLD,
      responseJson.signatures,
      {
        destinationAddress: destinationAddress,
        destinationChain: destinationChain,
        asset: 'eth',
        address: depositAddress,
        sourceChain: srcChain,
        coinType: 'ethereum',
      }
    )
    console.log('Verification result:', result)
    if (!result.success) {
      console.error('Verification failed')
      return
    }

    // === Set up environment ===
    const UNIT_FACET_ABI = unitFacetArtifact.abi as Abi

    const { publicClient, walletAccount, lifiDiamondContract } =
      await setupEnvironment(srcChain, UNIT_FACET_ABI)
    const signerAddress = walletAccount.address
    const destinationChainId = 999 // hyperevm same as hyperliquid

    // // === Contract addresses ===

    const amount = 50000000000000000 // 5 * 1e16, 0.05 XPL

    console.info(
      `Bridge ${amount} ${asset} from ${srcChain} --> ${destinationChain}`
    )
    console.info(`Connected wallet address: ${signerAddress}`)

    await ensureBalance(zeroAddress, signerAddress, BigInt(amount), publicClient)

    // === Backend re-signing ===

    console.log('\nSimulating backend EIP-712 signing...')

    const sourceChainId = networks[srcChain]?.chainId
    if (!sourceChainId) {
      throw new Error(`Chain ${srcChain} not found in networks configuration`)
    }

    const domain = {
      name: 'LI.FI Unit Facet',
      version: '1',
      chainId: sourceChainId,
      verifyingContract: lifiDiamondContract?.address,
    } as const

    const types = {
      UnitPayload: [
        { name: 'depositAddress', type: 'address' },
        { name: 'sourceChainId', type: 'uint256' },
        { name: 'destinationChainId', type: 'uint256' },
        { name: 'receiver', type: 'address' },
        { name: 'sendingAssetId', type: 'address' },
      ],
    } as const

    const message = {
      depositAddress: depositAddress,
      sourceChainId: BigInt(sourceChainId),
      destinationChainId: BigInt(destinationChainId),
      receiver: signerAddress,
      sendingAssetId: zeroAddress, // This is XPL, the native asset on plasma, so its address is zero
    } as const

    const backendSignature = await walletAccount.signTypedData({
      domain,
      types,
      primaryType: 'UnitPayload',
      message: message as any,
    })

    console.log('Generated EIP-712 Signature:', backendSignature)

    // === Prepare bridge data ===
    const bridgeData: ILiFi.BridgeDataStruct = {
      // Edit fields as needed
      transactionId: `0x${randomBytes(32).toString('hex')}`,
      bridge: 'unit',
      integrator: 'ACME Devs',
      referrer: zeroAddress,
      sendingAssetId: zeroAddress,
      receiver: signerAddress,
      destinationChainId,
      minAmount: amount,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    const unitData: UnitFacet.UnitDataStruct = {
      depositAddress: depositAddress,
      signature: backendSignature,
    }

    console.log('bridgeData', bridgeData)
    console.log('unitData', unitData)
    console.log('amount', amount)

    // === Start bridging ===    
    await executeTransaction(
      () =>
        (lifiDiamondContract as any).write.startBridgeTokensViaUnit(
          [bridgeData, unitData],
          { value: amount.toString() }
        ),
      'Starting bridge tokens via Unit',
      publicClient,
      true
    )
  }

  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
