import { ethers } from 'ethers'
import { EthersAdapter } from '@safe-global/protocol-kit'
import Safe from '@safe-global/protocol-kit'
import SafeApiKit, { OwnerResponse } from '@safe-global/api-kit'
import { SafeTransactionDataPartial } from '@safe-global/safe-core-sdk-types'
import { safeApiUrls } from './config'
import { argv, exit } from 'process'

// Parse incoming arguments
const [, , diamondAddress, rawCuts, network, rpcUrl, privateKey] = argv

const ownerABI = ['function owner() external view returns (address)']

// Create ethers provider and signer from private key
let safeOwner = new ethers.Wallet(privateKey as string)
const provider = new ethers.JsonRpcProvider(rpcUrl)
const contract = new ethers.Contract(diamondAddress, ownerABI, provider)
safeOwner = safeOwner.connect(provider)

// Initialize the Safe API
const ethAdapter = new EthersAdapter({
  ethers,
  signerOrProvider: safeOwner,
})

const safeService = new SafeApiKit({
  chainId: BigInt(provider._network.chainId),
  txServiceUrl: safeApiUrls[network],
})

const main = async () => {
  console.info('Building SAFE TX Proposal..')

  // Get owned SAFE addresses
  const res: OwnerResponse = await safeService.getSafesByOwner(
    await safeOwner.getAddress()
  )

  const safeAddress = await contract.owner()
  if (!res.safes.length || !res.safes.includes(safeAddress)) {
    console.error(
      'You do not have acccess to any SAFE addresses that can upgrade this diamond.'
    )
    exit(1)
  }

  console.info('SAFE Address: ', safeAddress)
  console.info('Diamond Address: ', diamondAddress)

  // Parse the raw diamond cuts
  const cuts = JSON.parse(rawCuts)

  console.info('Cuts: ', cuts)

  // Instantiate a SAFE instance
  const safeSdk: Safe = await Safe.create({
    ethAdapter,
    safeAddress,
  })

  // Get the latest nonce from the SAFE
  let nonce = await safeSdk.getNonce()

  // Broadcast each cut as a SAFE transaction proposal
  console.info(`Proposing ${cuts.length} transactions...`)
  for (const cut of cuts) {
    const safeTransactionData: SafeTransactionDataPartial = {
      to: diamondAddress,
      value: '0',
      data: cut,
      nonce,
    }
    const safeTransaction = await safeSdk.createTransaction({
      transactions: [safeTransactionData],
    })

    const senderAddress = await safeOwner.getAddress()
    const safeTxHash = await safeSdk.getTransactionHash(safeTransaction)
    const signature = await safeSdk.signHash(safeTxHash)

    console.info('Signer Address', senderAddress)
    console.info('Safe Address', safeAddress)
    console.info('Network', network)
    console.info('Proposing transaction to', diamondAddress)

    // Propose transaction to the service
    await safeService.proposeTransaction({
      safeAddress: await safeSdk.getAddress(),
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress,
      senderSignature: signature.data,
    })

    console.info('Transaction proposed')

    nonce++
  }
}

// Main entry point
main()
  .then(() => {
    console.info('Done!')
    exit(0)
  })
  .catch((e) => {
    console.error(e)
    exit(1)
  })
