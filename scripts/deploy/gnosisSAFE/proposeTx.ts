import { ethers, Wallet } from 'ethers'
import { EthersAdapter } from '@safe-global/protocol-kit'
import Safe from '@safe-global/protocol-kit'
import SafeApiKit, { OwnerResponse } from '@safe-global/api-kit'
import dotenv from 'dotenv'
import {
  MetaTransactionData,
  SafeTransactionDataPartial,
} from '@safe-global/safe-core-sdk-types'
dotenv.config()

const safeOwner = new ethers.Wallet(
  process.env.PRIVATE_KEY_PRODUCTION as string
)
const provider = ethers.getDefaultProvider('homestead')
safeOwner.connect(provider)

const ethAdapter = new EthersAdapter({
  ethers,
  signerOrProvider: provider,
})

const safeService = new SafeApiKit({
  txServiceUrl: 'https://safe-transaction-mainnet.safe.global',
  ethAdapter,
})

const main = async () => {
  console.info('SAFE TX Proposal')
  const res: OwnerResponse = await safeService.getSafesByOwner(
    await safeOwner.getAddress()
  )
  const safeAddress = res.safes[0]
  console.info(`SAFE Address\n======\n${res.safes[0]}`)
  console.info('Diamond Address', process.argv[2])

  const safeSdk: Safe = await Safe.create({
    ethAdapter,
    safeAddress,
  })

  const cuts = JSON.parse(process.argv[3])
  const safeTransactionData: MetaTransactionData[] = []
  for (const cut of cuts) {
    safeTransactionData.push({
      to: '0x9FcB9Aaa138DBb2Cbf484Ba43285ca4b60b56D09',
      value: '0',
      data: cut,
      operation: 0,
    })
  }
  const tx = await safeSdk.createTransaction({ safeTransactionData })
  console.log(tx)
}

main()
