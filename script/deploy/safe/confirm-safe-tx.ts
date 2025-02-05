import { defineCommand, runMain } from 'citty'
import { type SafeApiKitConfig } from '@safe-global/api-kit'
import { Abi, Chain, Hex, decodeFunctionData, parseAbi } from 'viem'
import { EthersAdapter } from '@safe-global/protocol-kit'
const { default: SafeApiKit } = await import('@safe-global/api-kit')
const { default: Safe } = await import('@safe-global/protocol-kit')
import { ethers } from 'ethers6'
import consola from 'consola'
import * as chains from 'viem/chains'
import { getSafeUtilityContracts } from './config'
import {
  NetworksObject,
  getAllActiveNetworks,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'
import * as dotenv from 'dotenv'
import { SafeMultisigTransactionResponse } from '@safe-global/safe-core-sdk-types'
import networksConfig from '../../../config/networks.json'
dotenv.config()

enum privateKeyType {
  SAFE_SIGNER,
  DEPLOYER,
}

const networks: NetworksObject = networksConfig

const ABI_LOOKUP_URL = `https://api.openchain.xyz/signature-database/v1/lookup?function=%SELECTOR%&filter=true`

const allNetworks = Object.keys(networksConfig)

// In order to skip specific networks simple comment them in
const skipNetworks: string[] = [
  // 'mainnet',
  // 'arbitrum',
  // 'aurora',
  // 'avalanche',
  // 'base',
  // 'blast',
  // 'boba',
  // 'bsc',
  // 'celo',
  // 'cronos',
  // 'fantom',
  // 'fraxtal',
  // 'fuse',
  // 'gnosis',
  // 'gravity',
  // 'immutablezkevm',
  // 'kaia',
  // 'linea',
  // 'mantle',
  // 'metis',
  // 'mode',
  // 'moonbeam',
  // 'moonriver',
  // 'optimism',
  // 'opbnb',
  // 'polygon',
  // 'polygonzkevm',
  // 'rootstock',
  // 'scroll',
  // 'sei',
  // 'taiko',
  // 'xlayer',
  // 'zksync',
]
const defaultNetworks = allNetworks.filter(
  (network) =>
    !skipNetworks.includes(network) &&
    network !== 'localanvil' &&
    networks[network.toLowerCase()].status === 'active' // <<< deactivate this to operate on non-active networks
)

const storedResponses: Record<string, string> = {}

// Quickfix to allow BigInt printing https://stackoverflow.com/a/70315718
;(BigInt.prototype as any).toJSON = function () {
  return this.toString()
}

const retry = async <T>(func: () => Promise<T>, retries = 3): Promise<T> => {
  try {
    const result = await func()
    return result
  } catch (e) {
    if (retries > 0) {
      consola.error('Retry after error:', e)
      return retry(func, retries - 1)
    }

    throw e
  }
}

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) {
  // @ts-ignore
  chainMap[k] = v
}

const func = async (
  network: string,
  privateKey: string,
  privKeyType: privateKeyType,
  rpcUrl?: string
) => {
  console.info(' ')
  consola.info('-'.repeat(80))

  const safeWebUrl = networks[network.toLowerCase()].safeWebUrl

  const chain = getViemChainForNetworkName(network)

  const config: SafeApiKitConfig = {
    chainId: BigInt(chain.id),
    txServiceUrl: networks[network.toLowerCase()].safeApiUrl,
  }

  let safeService
  try {
    safeService = new SafeApiKit(config)
  } catch (err) {
    consola.error(`error encountered while setting up SAFE service: ${err}`)
    consola.error(`skipping network ${network}`)
    consola.error(
      `Please check this SAFE NOW to make sure no pending transactions are missed:`
    )
    console.log(`${safeWebUrl}`)
    return
  }

  const safeAddress = networks[network.toLowerCase()].safeAddress

  const parsedRpcUrl = rpcUrl || chain.rpcUrls.default.http[0]
  const provider = new ethers.JsonRpcProvider(parsedRpcUrl)
  const signer = new ethers.Wallet(privateKey, provider)

  const signerAddress = await signer.getAddress()

  consola.info('Chain:', chain.name)
  consola.info('Signer:', signerAddress)

  const ethAdapter = new EthersAdapter({
    ethers,
    signerOrProvider: signer,
  })

  let protocolKit: Safe
  try {
    protocolKit = await Safe.create({
      ethAdapter,
      safeAddress: safeAddress,
      contractNetworks: getSafeUtilityContracts(chain.id),
    })
  } catch (err) {
    consola.error(`error encountered while setting up protocolKit: ${err}`)
    consola.error(`skipping network ${network}`)
    consola.error(
      `Please check this network's SAFE manually NOW to make sure no pending transactions are missed`
    )
    return
  }

  let allTx
  try {
    allTx = await retry(() => safeService.getPendingTransactions(safeAddress))
  } catch (err) {
    consola.error(
      `error encountered while getting pending transactions for network ${network}`
    )
    consola.error(`skipping network ${network}`)
    consola.error(
      `Please check this network's SAFE manually NOW to make sure no pending transactions are missed`
    )
    return
  }

  // Function to sign a transaction
  const signTransaction = async (
    txToConfirm: SafeMultisigTransactionResponse,
    safeWebUrl: string
  ) => {
    consola.info('Signing transaction', txToConfirm.safeTxHash)
    const signedTx = await protocolKit.signTransaction(txToConfirm)
    const dataToBeSigned = signedTx.getSignature(signerAddress)?.data
    if (!dataToBeSigned) throw Error(`error while preparing data to be signed`)

    try {
      await retry(() =>
        safeService.confirmTransaction(txToConfirm.safeTxHash, dataToBeSigned)
      )
    } catch (err) {
      consola.error('Error while trying to sign the transaction')
      consola.error(
        `Try to re-run this script again or check the SAFE web URL: ${safeWebUrl}`
      )
      throw Error(`Transaction could not be signed`)
    }
    consola.success('Transaction signed', txToConfirm.safeTxHash)
  }

  // Function to execute a transaction
  async function executeTransaction(
    txToConfirm: SafeMultisigTransactionResponse,
    safeWebUrl: string
  ) {
    consola.info('Executing transaction', txToConfirm.safeTxHash)
    try {
      const exec = await protocolKit.executeTransaction(txToConfirm)
      await exec.transactionResponse?.wait()
    } catch (err) {
      consola.error('Error while trying to execute the transaction')
      consola.error(
        `Try to re-run this script again or check the SAFE web URL: ${safeWebUrl}`
      )
      throw Error(`Transaction could not be executed`)
    }

    consola.success('Transaction executed', txToConfirm.safeTxHash)
    console.info(' ')
    console.info(' ')
  }

  // only show transaction Signer has not confirmed yet
  const txs = allTx.results.filter(
    (tx) =>
      !tx.confirmations?.some(
        (confirmation) => confirmation.owner === signerAddress
      )
  )

  if (!txs.length) {
    consola.success('No pending transactions')
    return
  }

  for (const tx of txs.sort((a, b) => {
    if (a.nonce < b.nonce) return -1
    if (a.nonce > b.nonce) return 1
    return 0
  })) {
    let abi
    let abiInterface: Abi
    let decoded
    if (tx.data) {
      const selector = tx.data.substring(0, 10)
      const url = ABI_LOOKUP_URL.replace('%SELECTOR%', selector)
      const response = await fetch(url)
      const data = await response.json()
      if (
        data.ok &&
        data.result &&
        data.result.function &&
        data.result.function[selector]
      ) {
        abi = data.result.function[selector][0].name
        const fullAbiString = `function ${abi}`
        abiInterface = parseAbi([fullAbiString])
        decoded = decodeFunctionData({
          abi: abiInterface,
          data: tx.data as Hex,
        })
      }
    }

    consola.info('Method:', abi)
    consola.info('Decoded Data:', JSON.stringify(decoded, null, 2))
    consola.info('Nonce:', tx.nonce)
    consola.info('To:', tx.to)
    consola.info('Value:', tx.value)
    consola.info('Data:', tx.data)
    consola.info('Proposer:', tx.proposer)
    consola.info('Safe Tx Hash:', tx.safeTxHash)

    const storedResponse = tx.data ? storedResponses[tx.data] : undefined

    const ok = storedResponse
      ? true
      : await consola.prompt('Confirm Transaction?', {
          type: 'confirm',
        })

    if (!ok) {
      continue
    }

    // if this script is run with the SAFE_SIGNER_PRIVATE_KEY then execution is never an option so we can blindly select the SIGN action here
    const action =
      privKeyType == privateKeyType.SAFE_SIGNER
        ? 'Sign'
        : storedResponse ??
          (await consola.prompt('Action', {
            type: 'select',
            options: ['Sign & Execute Now', 'Sign', 'Execute Now'],
          }))
    storedResponses[tx.data!] = action

    const txToConfirm = await retry(() =>
      safeService.getTransaction(tx.safeTxHash)
    )

    if (action === 'Sign & Execute Later') {
      consola.info('Signing transaction', tx.safeTxHash)
      const signedTx = await protocolKit.signTransaction(txToConfirm)
      await retry(() =>
        safeService.confirmTransaction(
          tx.safeTxHash,
          // @ts-ignore
          signedTx.getSignature(signerAddress).data
        )
      )
      consola.success('Transaction signed', tx.safeTxHash)
    }

    if (action === 'Sign') {
      try {
        await signTransaction(txToConfirm, safeWebUrl)
      } catch {}
    }

    if (action === 'Sign & Execute Now') {
      try {
        await signTransaction(txToConfirm, safeWebUrl)
        await executeTransaction(txToConfirm, safeWebUrl)
      } catch {}
    }

    if (action === 'Execute Now') {
      try {
        await executeTransaction(txToConfirm, safeWebUrl)
      } catch {}
    }
  }
}

const main = defineCommand({
  meta: {
    name: 'propose-to-safe',
    description: 'Propose a transaction to a Gnosis Safe',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name',
    },
    rpcUrl: {
      type: 'string',
      description: 'RPC URL',
    },
    privateKey: {
      type: 'string',
      description: 'Private key of the signer',
      required: false,
    },
  },
  async run({ args }) {
    const networks = args.network ? [args.network] : defaultNetworks

    // if no privateKey was supplied, read directly from env
    let privateKey = args.privateKey
    if (!privateKey) {
      const key = await consola.prompt(
        'Which private key do you want to use from your .env file?',
        {
          type: 'select',
          options: ['PRIVATE_KEY_PRODUCTION', 'SAFE_SIGNER_PRIVATE_KEY'],
        }
      )

      privateKey = process.env[key] ?? ''

      if (privateKey == '')
        throw Error(`could not find a key named ${key} in your .env file`)
    }

    for (const network of networks) {
      await func(
        network,
        privateKey,
        privateKey == 'PRIVATE_KEY_PRODUCTION'
          ? privateKeyType.DEPLOYER
          : privateKeyType.SAFE_SIGNER,
        args.rpcUrl
      )
    }
  },
})

runMain(main)
