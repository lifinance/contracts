import { ethers } from 'ethers'
import { EthersAdapter } from '@safe-global/protocol-kit'
import Safe from '@safe-global/protocol-kit'
import SafeApiKit, {
  OwnerResponse,
  ProposeTransactionProps,
} from '@safe-global/api-kit'
import { SafeTransactionDataPartial } from '@safe-global/safe-core-sdk-types'
import { safeApiUrls } from './config'
import { argv, exit } from 'process'

// Parse incoming arguments
const [, , diamondAddress, rawCuts, network, rpcUrl, privateKey] = argv

const ownerABI = ['function owner() external view returns (address)']
const contract = new ethers.Contract(diamondAddress, ownerABI)

// Create ethers provider and signer from private key
let safeOwner = new ethers.Wallet(privateKey as string)
const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
safeOwner = safeOwner.connect(provider)

// Initialize the Safe API
const ethAdapter = new EthersAdapter({
  ethers,
  signerOrProvider: safeOwner,
})

const safeService = new SafeApiKit({
  txServiceUrl: safeApiUrls[network],
  ethAdapter,
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

  // Instantiate a SAFE instance
  const safeSdk: Safe = await Safe.create({
    ethAdapter,
    safeAddress,
  })

  // Parse the raw diamond cuts
  const cuts = JSON.parse(rawCuts)

  // Get the latest nonce from the SAFE
  let nonce = await safeSdk.getNonce()

  // Broadcast each cut as a SAFE transaction proposal
  console.info(`Proposing ${cuts.length} transactions...`)
  let i = 1
  for (const cut of cuts) {
    const safeTransactionData: SafeTransactionDataPartial = {
      to: diamondAddress,
      value: '0',
      data: cut,
      nonce,
    }
    const tx = await safeSdk.createTransaction({ safeTransactionData })
    const txHash = await safeSdk.getTransactionHash(tx)
    const txHashSignature = await safeSdk.signTransactionHash(txHash)
    const proposal: ProposeTransactionProps = {
      safeAddress: safeAddress,
      safeTransactionData: tx.data,
      safeTxHash: txHash,
      senderAddress: await safeOwner.getAddress(),
      senderSignature: txHashSignature.data,
    }
    console.info(`Sending proposal [${i}]...`)
    await safeService.proposeTransaction(proposal)
    nonce++
    i++
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
