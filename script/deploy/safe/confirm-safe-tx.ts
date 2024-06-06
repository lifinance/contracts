import { defineCommand, runMain } from 'citty'
import { type SafeApiKitConfig } from '@safe-global/api-kit'
import { Abi, Chain, Hex, decodeFunctionData, parseAbi } from 'viem'
import Safe, { EthersAdapter } from '@safe-global/protocol-kit'
import SafeApiKit from '@safe-global/api-kit'
import { ethers } from 'ethers6'
import consola from 'consola'
import * as chains from 'viem/chains'
import { chainNameMappings, safeAddresses, safeApiUrls } from './config'

const ABI_LOOKUP_URL = `https://api.openchain.xyz/signature-database/v1/lookup?function=%SELECTOR%&filter=true`

// Keep a list here instead of referencing on to allow to easily comment out some chains
const defaultNetworks = [
  'mainnet',
  'arbitrum',
  'aurora',
  'avalanche',
  'base',
  'boba',
  'bsc',
  'celo',
  'fantom',
  'fuse',
  'gnosis',
  'moonbeam',
  'moonriver',
  'optimism',
  'polygon',
  'polygonZkEvm',
  'scroll',
  'gnosis',
  'zkSync',
  'linea',
]

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

const func = async (network: string, privateKey: string, rpcUrl?: string) => {
  const chainName = chainNameMappings[network] || network
  const chain: Chain = chainMap[chainName]

  const config: SafeApiKitConfig = {
    chainId: BigInt(chain.id),
    txServiceUrl: safeApiUrls[chainName.toLowerCase()],
  }

  const safeService = new SafeApiKit(config)

  const safeAddress = safeAddresses[chainName.toLowerCase()]

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

  const protocolKit = await Safe.create({
    ethAdapter,
    safeAddress: safeAddress,
  })

  const allTx = await retry(() =>
    safeService.getPendingTransactions(safeAddress)
  )

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

    const action =
      storedResponse ??
      (await consola.prompt('Action', {
        type: 'select',
        options: ['Sign & Execute Later', 'Execute Now'],
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

    if (action === 'Execute Now') {
      consola.info('Executing transaction', tx.safeTxHash)
      const exec = await protocolKit.executeTransaction(txToConfirm)
      await exec.transactionResponse?.wait()
      consola.success('Transaction executed', tx.safeTxHash)
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
      required: true,
    },
  },
  async run({ args }) {
    const networks = args.network ? [args.network] : defaultNetworks

    for (const network of networks) {
      await func(network, args.privateKey, args.rpcUrl)
    }
  },
})

runMain(main)
