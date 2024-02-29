import {
  providers,
  Wallet,
  constants,
  TypedDataDomain,
  utils,
  TypedDataField,
  ethers,
} from 'ethers'
import deployments from '../../deployments/bsc.staging.json'
import {
  ERC20,
  ERC20__factory,
  Permit2Proxy,
  Permit2Proxy__factory,
} from '../../typechain'
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
const testAmount = '100000000000000000000' // 100 USDC

const DEFAULT_EXPIRATION = 5000 * 60 // 5 minutes

let signer: Wallet
let executor: Wallet

// get contracts
let usdc_contract: ERC20
let permit2Proxy_contract: Permit2Proxy

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

  // logDebug(`Witness prepared: ${JSON.stringify(witness, null, 2)}`)

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

const getValuesAndTypesHardcoded = (
  executor: Wallet,
  diamondAddress: string,
  diamondCalldata: string,
  nonce: string,
  deadline: string
) => {
  const types = {
    PermitWitnessTransferFrom: [
      {
        name: 'permitted',
        type: 'TokenPermissions',
      },
      {
        name: 'spender',
        type: 'address',
      },
      {
        name: 'nonce',
        type: 'uint256',
      },
      {
        name: 'deadline',
        type: 'uint256',
      },
      {
        name: 'witness',
        type: 'Witness',
      },
    ],
    TokenPermissions: [
      {
        name: 'token',
        type: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
      },
    ],
    Witness: [
      {
        name: 'tokenReceiver',
        type: 'address',
      },
      {
        name: 'diamondAddress',
        type: 'address',
      },
      {
        name: 'diamondCalldata',
        type: 'bytes',
      },
    ],
  }

  const values = {
    permitted: {
      token: srcTokenAddress,
      amount: testAmount,
    },
    spender: PERMIT_2_PROXY,
    nonce: nonce,
    deadline: deadline,
    witness: {
      tokenReceiver: PERMIT_2_PROXY,
      diamondAddress: diamondAddress,
      diamondCalldata: diamondCalldata,
    },
  }

  return { types, values }
}

const getPermitObject = async (signer: Wallet) => {
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
  logDebug(`Permit object created: ${JSON.stringify(permit, null, 2)}`)

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
  const permit = await getPermitObject(signer)

  // get witness data
  const witness = getWitness(PERMIT_2_PROXY, diamondAddress, diamondCalldata)

  // const { values, types } = getValuesAndTypesHardcoded(
  //   executor,
  //   diamondAddress,
  //   diamondCalldata,
  //   permit.nonce.toString(),
  //   permit.deadline.toString()
  // )

  // get typed data that can be sent to user for signing
  // const { domain, types, values } = SignatureTransfer.getPermitData(
  //   permit,
  //   PERMIT2_ADDRESS,
  //   SRC_CHAIN_ID,
  //   witness
  // )

  const unsignedData = {
    domain,
    types,
    values,
  }

  logDebug(`unsignedData: ${JSON.stringify(unsignedData, null, 2)}`)

  // the "domain" created by SignatureTransfer.getPermitData() is erroneous (issue is the missing/wrong chainId value)
  // if we use this manually created domain, signature can be produced
  // const domain: TypedDataDomain = {
  //   name: 'GaslessTx',
  //   version: '1',
  //   chainId: 56,
  //   verifyingContract: PERMIT2_ADDRESS,
  // }

  const typedValues = values as PermitTransferFrom

  logSuccess('Data prepared for signing')
  // logDebug(`permit: ${JSON.stringify(permit, null, 2)}`)

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

  logDebug(``)
  logDebug(`witnessData: ${JSON.stringify(witnessData)}`)
  logSuccess(`Witness data encoded`)

  return witnessData
}

const prepareWalletsAndContracts = () => {
  const RPC_URL = process.env.ETH_NODE_URI_BSC
  const PRIVATE_KEY_OWNER = process.env.PRIVATE_KEY
  const PRIVATE_KEY_EXECUTOR = process.env.PRIVATE_KEY_EXECUTOR

  // get wallet
  const provider = new providers.JsonRpcProvider(RPC_URL)
  signer = new Wallet(PRIVATE_KEY_OWNER as string, provider)
  executor = new Wallet(PRIVATE_KEY_EXECUTOR as string, provider)

  logDebug(`Using this wallet for signing:   ${signer.address}`)
  logDebug(`Using this wallet for executing: ${executor.address}`)

  // get contracts
  usdc_contract = ERC20__factory.connect(srcTokenAddress, provider)
  permit2Proxy_contract = Permit2Proxy__factory.connect(
    PERMIT_2_PROXY,
    executor
  )
}

// ###########################################################

const main_usePermit2SDK = async () => {
  console.log(`Starting main_Permit2SDK`)

  prepareWalletsAndContracts()

  // give infinite approval from wallet to Uniswap Permit2 contract, if not existing already
  if ((await usdc_contract.allowance(signer.address, PERMIT_2_BSC)).isZero())
    await maxApproveTokenToPermit2(signer, usdc_contract, PERMIT_2_BSC)

  // fetch route from LI.FI API and extract diamondAddress and diamondCalldata
  const { diamondAddress, diamondCalldata } = await getRouteFromLiFiAPI(signer)

  // create permit
  const permitForSignature: PermitTransferFrom = {
    permitted: {
      token: BSC_USDC_ADDRESS,
      amount: testAmount,
    },
    spender: PERMIT_2_PROXY,
    nonce: 1,
    deadline: constants.MaxUint256.toString(),
  }
  // create witness
  const witness = getWitness(PERMIT_2_PROXY, diamondAddress, diamondCalldata)

  // prepare data for signing
  const { domain, types, values } = SignatureTransfer.getPermitData(
    permitForSignature,
    PERMIT2_ADDRESS,
    SRC_CHAIN_ID,
    witness
  )

  // sign permit message
  const signature = await signer._signTypedData(domain, types, values)

  // encode witnessData as bytes value (will be a function argument for the call)
  const witnessData = encodeWitnessData(diamondAddress, diamondCalldata)

  // verify signature
  const expectedSignerAddress = signer.address
  const recoveredAddress = utils.verifyTypedData(
    domain,
    types,
    values,
    signature
  )
  logDebug(
    `Signer address (${signer.address}) successfully recovered: ${
      recoveredAddress === expectedSignerAddress
    }`
  )

  const permitForCall = {
    permitted: {
      token: BSC_USDC_ADDRESS,
      amount: testAmount,
    },
    nonce: 1,
    deadline: constants.MaxUint256.toString(),
  }

  // logDebug(`signature: ${JSON.stringify(signature)}`)
  logDebug(`permitForSignature: ${JSON.stringify(permitForSignature, null, 2)}`)
  logDebug(`permitForCall: ${JSON.stringify(permitForCall, null, 2)}`)
  // logDebug(`permit2Proxy: ${JSON.stringify(permit2Proxy)}`)

  // trigger transaction using calldata and user signature
  const tx = await permit2Proxy_contract.callDiamondWithPermit2SignatureSingle(
    permitForCall,
    testAmount,
    witnessData,
    signer.address,
    signature
  )

  await tx.wait()

  logSuccess('\n\n script successfully completed')
}

const main_useHardcodedValues = async () => {
  console.log(`Starting main_HardcodedValues`)

  prepareWalletsAndContracts()

  // give infinite approval from wallet to Uniswap Permit2 contract, if not existing already
  if ((await usdc_contract.allowance(signer.address, PERMIT_2_BSC)).isZero())
    await maxApproveTokenToPermit2(signer, usdc_contract, PERMIT_2_BSC)

  // fetch route from LI.FI API and extract diamondAddress and diamondCalldata
  const { diamondAddress, diamondCalldata } = await getRouteFromLiFiAPI(signer)

  // prepare data for signing
  const { permit, unsignedData } = await prepareDataForSigning(
    signer,
    executor,
    diamondAddress,
    diamondCalldata
  )

  // sign quote/calldata using wallet
  const signature = await signTypedData(signer, unsignedData)

  // encode witnessData as bytes value (will be a function argument for the call)
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
  // logDebug(`permit: ${JSON.stringify(permit, null, 2)}`)
  // logDebug(`permit2Proxy: ${JSON.stringify(permit2Proxy)}`)

  // trigger transaction using calldata and user signature
  const tx = await permit2Proxy_contract.callDiamondWithPermit2SignatureSingle(
    // adjustedPermit,
    permit,
    testAmount,
    witnessData,
    signer.address,
    signature
  )

  await tx.wait()

  logSuccess('\n\n script successfully completed')
}

// approach suggested by ChatGPT
async function main_useAlternativeSignatureApproach() {
  console.log(`Starting main_alternativeSignatureApproach`)

  prepareWalletsAndContracts()

  // give infinite approval from wallet to Uniswap Permit2 contract, if not existing already
  if ((await usdc_contract.allowance(signer.address, PERMIT_2_BSC)).isZero())
    await maxApproveTokenToPermit2(signer, usdc_contract, PERMIT_2_BSC)

  // fetch route from LI.FI API and extract diamondAddress and diamondCalldata
  const { diamondAddress, diamondCalldata } = await getRouteFromLiFiAPI(signer)

  // Prepare the Permit2 signature details
  // const nonce = await permit2.nonces(tokenAddress, owner)
  const nonce = 284
  const deadline = Math.floor(Date.now() / 1000) + 3600 // Signature deadline, 1 hour from now

  // // Define the permit structure based on your Permit2 contract requirements
  // const permitForSignature = {
  //   permitted: {
  //     token: BSC_USDC_ADDRESS,
  //     amount: testAmount,
  //   },
  //   spender: PERMIT_2_PROXY,
  //   nonce,
  //   deadline,
  // }

  // Define witness structure according to your contract requirements
  const witness = {
    tokenReceiver: PERMIT_2_PROXY,
    diamondAddress: diamondAddress,
    diamondCalldata: diamondCalldata,
  }

  // Encode the permit and witness data for signing
  const permitDataToSign = ethers.utils.defaultAbiCoder.encode(
    ['tuple(address token, uint256 amount)', 'address', 'uint256', 'uint256'],
    [[BSC_USDC_ADDRESS, testAmount], PERMIT_2_PROXY, nonce, deadline]
  )
  // const permitDataToSign = ethers.utils.defaultAbiCoder.encode(
  //   ['tuple(address token, uint256 amount)', 'uint256', 'uint256'],
  //   [[BSC_USDC_ADDRESS, testAmount], nonce, deadline]
  // )
  const witnessDataToSign = ethers.utils.defaultAbiCoder.encode(
    // ['address', 'address', 'bytes'],
    [
      'tuple(address tokenReceiver, address diamondAddress, bytes diamondCalldata)',
    ],
    [
      witness.tokenReceiver,
      witness.diamondAddress,
      ethers.utils.arrayify(witness.diamondCalldata),
    ]
  )

  // Combine permit and witness data for signing
  const combinedDataToSign = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['bytes', 'bytes'],
      [permitDataToSign, witnessDataToSign]
    )
  )

  // Sign the combined data
  const signature = await signer.signMessage(
    ethers.utils.arrayify(combinedDataToSign)
  )

  // logDebug(`permit: ${JSON.stringify(permitForSignature, null, 2)}`)
  logDebug(`witness: ${JSON.stringify(witness, null, 2)}`)
  logDebug(`signature: ${signature}`)

  // create permit parameter for contract call (has less properties than the one that was signed)
  const permitForCall = {
    permitted: {
      token: BSC_USDC_ADDRESS,
      amount: testAmount,
    },
    nonce,
    deadline,
  }

  // Call Permit2Proxy to execute a gasless transaction
  const tx = await permit2Proxy_contract.callDiamondWithPermit2SignatureSingle(
    permitForCall,
    testAmount,
    ethers.utils.defaultAbiCoder.encode(
      // ['address', 'address', 'bytes'],
      [
        'tuple(address tokenReceiver, address diamondAddress, bytes diamondCalldata)',
      ],
      [PERMIT_2_PROXY, diamondAddress, diamondCalldata]
    ),
    signer.address,
    signature
  )

  await tx.wait()

  console.log(`Transaction hash: ${tx.hash}`)
}

// main()
// main_usePermit2SDK()
main_useAlternativeSignatureApproach()
  .then(() => {
    console.log('Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('error')
    console.error(error)
    process.exit(1)
  })
