import {
  providers,
  Wallet,
  constants,
  TypedDataDomain,
  utils,
  TypedDataField,
} from 'ethers'
import deployments from '../../deployments/bsc.staging.json'
import { ERC20, ERC20__factory, Permit2Proxy__factory } from '../../typechain'
import chalk from 'chalk'
// import { LiFi, RouteOptions, RoutesRequest } from '@lifi/sdk'

import {
  PermitTransferFrom,
  PERMIT2_ADDRESS,
  PermitTransferFromData,
  SignatureTransfer,
} from '@uniswap/permit2-sdk'
import { defaultAbiCoder } from 'ethers/lib/utils'
import dotenv from 'dotenv'
dotenv.config()

const logSuccess = (msg: string) => {
  console.log(chalk.green(msg))
  console.log('')
}
const logDebug = (msg: string) => {
  if (DEBUG) console.log(chalk.yellow(msg))
}

// const POLYGON_USDT_ADDRESS = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f'
const POLYGON_USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
const BSC_USDC_ADDRESS = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
const LIFI_API_BASE_URL = 'https://li.quest/v1'
const PERMIT_2_PROXY = deployments.Permit2Proxy
const srcTokenAddress = BSC_USDC_ADDRESS
const SRC_CHAIN_ID = 56
const destTokenAddress = POLYGON_USDC_ADDRESS
const DEBUG = true

const PERMIT_2_BSC = '0x000000000022D473030F116dDEE9F6B43aC78BA3' // TODO: read from config

let tx
const testAmount = '10000000000000000000' // 10 USDC

const DEFAULT_EXPIRATION = 5000 * 60 // 5 minutes

interface Witness {
  witness: any
  witnessTypeName: string
  witnessType: Record<string, TypedDataField[]>
}

/**
 * Converts an expiration (in milliseconds) to a deadline (in seconds) suitable for the EVM.
 * Permit2 expresses expirations as deadlines, but JavaScript usually uses milliseconds,
 * so this is provided as a convenience function.
 */
function msToDeadline(expiration: number): number {
  return Math.floor((Date.now() + expiration) / 1000)
}

// a witness is additional data that is added to the to-be-signed data in order to restrict how the signature can be used
const getWitness = (
  tokenReceiver: string,
  diamondAddress: string,
  diamondCalldata: string
) => {
  const witness: Witness = {
    witness: {
      tokenReceiver: tokenReceiver,
      diamondAddress: diamondAddress,
      diamondCalldata: diamondCalldata,
    },
    witnessTypeName: 'Witness',
    witnessType: {
      Witness: [
        { name: 'tokenReceiver', type: 'address' },
        { name: 'diamondAddress', type: 'address' },
        { name: 'diamondCalldata', type: 'bytes' },
      ],
    },
  }

  return witness
}

const maxApproveTokenToPermit2 = async (
  signer: Wallet,
  token: ERC20,
  permit2: string
) => {
  console.log("Max approving USDC from wallet to Uniswap's Permit2...")
  tx = await token.connect(signer).approve(permit2, constants.MaxUint256)
  await tx.wait()
  logSuccess('  Token approved to Permit2 contract')
}

// //TODO: add SDK
// const getRouteFromLiFiSDK = async (signer: Wallet) => {
//   // get quote from LIFI API/SDK
//   // log('Getting route from LI.FI SDK now')+
//   // const lifiSDK = new LiFi({
//   //   integrator: 'Your dApp/company name',
//   // })
//   // const routeOptions: RouteOptions = {
//   //   slippage: 3 / 100, // 3%
//   //   order: 'RECOMMENDED',
//   // }
//   // const routesRequest: RoutesRequest = {
//   //   fromChainId: 137,
//   //   fromAmount: testAmount,
//   //   fromTokenAddress: destTokenAddress,
//   //   toChainId: 56,
//   //   toTokenAddress: destTokenAddress,
//   //   options: routeOptions,
//   // }
//   // const result = await lifiSDK.getRoutes(routesRequest)
//   // const routes = result.routes
//   // log('>>> Route received')
// }

const getRouteFromLiFiAPI = async (signer: Wallet) => {
  console.log('Getting route from LI.FI API now')
  const requestURL = `/quote?fromChain=BSC&toChain=POL&fromToken=${srcTokenAddress}&toToken=${destTokenAddress}&fromAddress=${signer.address}&toAddress=${signer.address}&fromAmount=${testAmount}&order=RECOMMENDED&slippage=0.005`
  const resp = await fetch(`${LIFI_API_BASE_URL}${requestURL}`)
  const apiResponse = await resp.json()

  // extract diamondAddress and calldata
  const diamondAddress = apiResponse.transactionRequest.to
  const diamondCalldata = apiResponse.transactionRequest.data

  logDebug(`  extracted diamondAddress: ${diamondAddress}`)
  logDebug(`  extracted diamondCalldata: ${diamondCalldata}`)

  logSuccess('  Route received')

  return { diamondAddress, diamondCalldata }
}

type PermitAndData = {
  permit: PermitTransferFrom
  unsignedData: PermitTransferFromData
}

// const getValuesAndTypesHardcoded = (
//   executor: Wallet,
//   diamondAddress: string,
//   diamondCalldata: string,
//   nonce: string,
//   deadline: string
// ) => {
//   const types = {
//     PermitWitnessTransferFrom: [
//       {
//         name: 'permitted',
//         type: 'TokenPermissions',
//       },
//       {
//         name: 'spender',
//         type: 'address',
//       },
//       {
//         name: 'nonce',
//         type: 'uint256',
//       },
//       {
//         name: 'deadline',
//         type: 'uint256',
//       },
//       {
//         name: 'witness',
//         type: 'Witness',
//       },
//     ],
//     TokenPermissions: [
//       {
//         name: 'token',
//         type: 'address',
//       },
//       {
//         name: 'amount',
//         type: 'uint256',
//       },
//     ],
//     Witness: [
//       {
//         name: 'tokenReceiver',
//         type: 'address',
//       },
//       {
//         name: 'diamondAddress',
//         type: 'address',
//       },
//       {
//         name: 'diamondCalldata',
//         type: 'bytes',
//       },
//     ],
//   }

//   const values = {
//     permitted: {
//       token: srcTokenAddress,
//       amount: testAmount,
//     },
//     spender: PERMIT_2_PROXY,
//     nonce: nonce,
//     deadline: deadline,
//     witness: {
//       tokenReceiver: PERMIT_2_PROXY,
//       diamondAddress: diamondAddress,
//       diamondCalldata: diamondCalldata,
//     },
//   }

//   return { types, values }
// }

const getPermitObject = async (signer: Wallet, executor: Wallet) => {
  const nonce = await signer.getTransactionCount()

  // define deadline
  const deadline = msToDeadline(DEFAULT_EXPIRATION)
  console.log(
    `deadline defined as now (${Math.floor(
      Date.now() / 1000
    )}) + 5 minutes >>>> ${deadline}`
  )
  // build permit object
  const permit: PermitTransferFrom = {
    permitted: {
      token: srcTokenAddress,
      amount: testAmount,
    },
    spender: PERMIT_2_PROXY,
    nonce: nonce,
    deadline: deadline,
  }
  logDebug(
    `PermitTransferFrom object created: ${JSON.stringify(permit, null, 2)}`
  )

  return permit
}

const prepareDataForSigning = async (
  signer: Wallet,
  executor: Wallet,
  diamondAddress: string,
  diamondCalldata: string
): Promise<PermitAndData> => {
  console.log(`preparing data for signature now`)

  // build permit object
  const permit = await getPermitObject(signer, executor)

  // get witness data
  const witness = getWitness(PERMIT_2_PROXY, diamondAddress, diamondCalldata)
  console.log(`Witness prepared: ${JSON.stringify(witness, null, 2)}`)

  // const { values, types } = getValuesAndTypesHardcoded(
  //   executor,
  //   diamondAddress,
  //   diamondCalldata,
  //   permit.nonce.toString(),
  //   permit.deadline.toString()
  // )

  // get typed data that can be sent to user for signing
  const { types, values } = SignatureTransfer.getPermitData(
    permit,
    PERMIT2_ADDRESS,
    SRC_CHAIN_ID,
    witness
  )

  // the "domain" created by SignatureTransfer.getPermitData() is erroneous (issue is the missing/wrong chainId value)
  // if we use this manually created domain, signature can be produced
  const domain: TypedDataDomain = {
    name: 'GaslessTx',
    version: '1',
    chainId: 56,
    verifyingContract: PERMIT2_ADDRESS,
  }

  const typedValues = values as PermitTransferFrom

  logSuccess('Data prepared for signing')
  logDebug(`permit: ${JSON.stringify(permit, null, 2)}`)
  logDebug(
    `unsignedData: ${JSON.stringify(
      { domain, types, values: typedValues },
      null,
      2
    )}`
  )

  return {
    permit: permit,
    unsignedData: { domain, types, values: typedValues },
  }
}

const signTypedData = async (signer: Wallet, data: PermitTransferFromData) => {
  console.log(`Signing data now`)
  const signature = await signer._signTypedData(
    data.domain,
    data.types,
    data.values
  )
  logSuccess(`Data signed`)
  return signature
}

const encodeWitnessData = (diamondAddress: string, diamondCalldata: string) => {
  console.log(`encoding Witness data now`)

  logDebug(`PERMIT_2_PROXY: ${PERMIT_2_PROXY}`)
  logDebug(`diamondAddress: ${diamondAddress}`)
  logDebug(`diamondCalldata: ${diamondCalldata}`)

  // encode witness data as a tuple/struct
  const witnessData = defaultAbiCoder.encode(
    ['tuple(address, address, bytes)'],
    [[PERMIT_2_PROXY, diamondAddress, diamondCalldata]]
  )

  logDebug(`witnessData: ${JSON.stringify(witnessData)}`)
  logSuccess(`Witness data encoded`)

  return witnessData
}

const main = async () => {
  console.log(`Starting script`)

  // const RPC_URL = process.env.ETH_NODE_URI_POLYGON
  const RPC_URL = process.env.ETH_NODE_URI_BSC
  const PRIVATE_KEY_OWNER = process.env.PRIVATE_KEY
  const PRIVATE_KEY_EXECUTOR = process.env.PRIVATE_KEY_EXECUTOR

  // logDebug(`RPC_URL: ${RPC_URL}`)
  // logDebug(`PRIVATE_KEY: ${PRIVATE_KEY}`)

  // get wallet
  const provider = new providers.JsonRpcProvider(RPC_URL)
  const signer = new Wallet(PRIVATE_KEY_OWNER as string, provider)
  const executor = new Wallet(PRIVATE_KEY_EXECUTOR as string, provider)

  logDebug(`Using this wallet for signing:   ${signer.address}`)
  logDebug(`Using this wallet for executing: ${executor.address}`)

  // get contracts
  const token = ERC20__factory.connect(srcTokenAddress, provider)
  const permit2Proxy = Permit2Proxy__factory.connect(PERMIT_2_PROXY, executor)

  // give infinite approval from wallet to Uniswap Permit2 contract, if not existing already
  if ((await token.allowance(signer.address, PERMIT_2_BSC)).isZero())
    await maxApproveTokenToPermit2(signer, token, PERMIT_2_BSC)

  // fetch route from LI.FI API and extract diamondAddress and diamondCalldata
  const { diamondAddress, diamondCalldata } = await getRouteFromLiFiAPI(signer)

  // create witness
  // create permit object
  // sign witness and permit

  // prepare data for signing
  const { permit, unsignedData } = await prepareDataForSigning(
    signer,
    executor,
    diamondAddress,
    diamondCalldata
    // srcChainId
  )

  // sign quote/calldata using wallet
  const signature = await signTypedData(signer, unsignedData)

  const witnessData = encodeWitnessData(diamondAddress, diamondCalldata)

  // verify signature
  const expectedSignerAddress = signer.address
  const recoveredAddress = utils.verifyTypedData(
    unsignedData.domain,
    unsignedData.types,
    unsignedData.values,
    signature
  )
  logDebug(
    `Signer address (${signer.address}) successfully recovered: ${
      recoveredAddress === expectedSignerAddress
    }`
  )

  // logDebug(`signature: ${JSON.stringify(signature)}`)
  logDebug(`permit: ${JSON.stringify(permit)}`)
  // logDebug(`permit2Proxy: ${JSON.stringify(permit2Proxy)}`)

  // trigger transaction using calldata and user signature
  const tx = await permit2Proxy.callDiamondWithPermit2SignatureSingle(
    permit,
    testAmount,
    witnessData,
    signer.address,
    signature
  )

  await tx.wait()

  // logDebug(`tx: ${JSON.stringify(tx)}`)
  logSuccess('\n\n script successfully completed')
}

main()
  .then(() => {
    console.log('Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('error')
    console.error(error)
    process.exit(1)
  })
