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
import enquirer from 'enquirer'

const [, , diamondAddress, rawCuts, network, rpcUrl, privateKey] = argv

let safeOwner = new ethers.Wallet(privateKey as string)
const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
safeOwner = safeOwner.connect(provider)

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
  const res: OwnerResponse = await safeService.getSafesByOwner(
    await safeOwner.getAddress()
  )

  const choice = await enquirer.prompt({
    type: 'select',
    name: 'safeAddress',
    message: 'Choose the SAFE address you would like to use.',
    choices: res.safes,
  })

  const safeAddress = (<{ safeAddress: string }>choice).safeAddress
  console.info('SAFE Address: ', safeAddress)
  console.info('Diamond Address: ', diamondAddress)

  const safeSdk: Safe = await Safe.create({
    ethAdapter,
    safeAddress,
  })

  const cuts = JSON.parse(rawCuts)
  let nonce = await safeSdk.getNonce()
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

main()
  .then(() => {
    console.info('Done!')
    exit(0)
  })
  .catch((e) => {
    console.error(e)
    exit(1)
  })
