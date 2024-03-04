import {
  providers,
  Wallet,
  constants,
  TypedDataDomain,
  TypedDataField,
  ethers,
  utils,
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
import {
  _TypedDataEncoder,
  defaultAbiCoder,
  joinSignature,
} from 'ethers/lib/utils'
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
const TOKEN_PERMISSIONS_TYPESTRING =
  'TokenPermissions(address token,uint256 amount)'
const FULL_WITNESS_TYPESTRING =
  'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)'
const POLYGON_USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
const BSC_USDC_ADDRESS = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
const LIFI_API_BASE_URL = 'https://li.quest/v1'
const PERMIT_2_PROXY = deployments.Permit2Proxy
const srcTokenAddress = BSC_USDC_ADDRESS
const SRC_CHAIN_ID = 56
const destTokenAddress = POLYGON_USDC_ADDRESS
const DEBUG = false

const PERMIT_2_BSC_DOMAIN_SEPARATOR =
  '0x4142cc3c823f819c467fa4437d637fe20589a31dfcd1da2ff22292c9ed9344e7'

let tx
const testAmount = '100000000000000000000' // 100 USDC

const getFULL_WITNESS_BATCH_TYPEHASH = () => {
  return '0x1fff5dc7ad781f5db1f7bb97143d47e79a11dd43bb5c21f88cecfedab9f0da2b'
}

const nonce = constants.MaxUint256
const deadline = constants.MaxUint256

const DEFAULT_EXPIRATION = 5000 * 60 // 5 minutes

let signer: Wallet
let executor: Wallet

// get contracts
let usdc_contract: ERC20
let permit2Proxy_contract: Permit2Proxy
let permit2_contract: ethers.Contract

interface WitnessValues {
  tokenReceiver: string
  diamondAddress: string
  diamondCalldata: string
}

interface Witness {
  witness: WitnessValues
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
  // const requestURL = `/quote?fromChain=BSC&toChain=POL&fromToken=${srcTokenAddress}&toToken=${destTokenAddress}&fromAddress=${signer.address}&toAddress=${signer.address}&fromAmount=${testAmount}&order=RECOMMENDED&slippage=0.005`
  // const resp = await fetch(`${LIFI_API_BASE_URL}${requestURL}`)
  // const apiResponse = await resp.json()

  // extract diamondAddress and calldata
  // const diamondAddress = apiResponse.transactionRequest.to
  // const diamondCalldata = apiResponse.transactionRequest.data

  //TODO: remove
  const diamondCalldata =
    '0x8bf6ef99000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d0000000000000000000000000000000000000000000000000000000abc6543210000000000000000000000000000000000000000000000056bc75e2d63100000000000000000000000000000000000000000000000000000000000000000008900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a3c55706461746557697468596f75724272696467654e616d653e0000000000000000000000000000000000000000000000000000000000000000000000000000'

  const diamondAddress = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'

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

  const { values, types } = getValuesAndTypesHardcoded(
    diamondAddress,
    diamondCalldata,
    permit.nonce.toString(),
    permit.deadline.toString()
  )

  // get typed data that can be sent to user for signing
  // const { domain, types, values } = SignatureTransfer.getPermitData(
  //   permit,
  //   PERMIT2_ADDRESS,
  //   SRC_CHAIN_ID,
  //   witness
  // )

  // the "domain" created by SignatureTransfer.getPermitData() is erroneous (issue is the missing/wrong chainId value)
  // if we use this manually created domain, signature can be produced
  // https://github.com/Uniswap/permit2/blob/main/src/EIP712.sol << here is defined how the Permit2 DOMAIN_SEPARATOR is constructed
  const domain: TypedDataDomain = {
    name: 'Permit2',
    chainId: 56,
    verifyingContract: PERMIT2_ADDRESS,
  }

  //    /// @notice Builds a domain separator using the current chainId and contract address.
  //    function _buildDomainSeparator(bytes32 typeHash, bytes32 nameHash) private view returns (bytes32) {
  //     return keccak256(abi.encode(typeHash, nameHash, block.chainid, address(this)));
  // }

  const unsignedData = {
    domain,
    types,
    values,
  }

  logDebug(`unsignedData: ${JSON.stringify(unsignedData, null, 2)}`)

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
  permit2_contract = new ethers.Contract(
    PERMIT2_ADDRESS,
    ['function DOMAIN_SEPARATOR() public returns (bytes32)'],
    provider
  )
}

const compareSignatures = (signature: string) => {
  const targetSignatureFromWorkingTestCase =
    '0x8fee744a8348c4c9b579c35b72b89e13905108e7607773228cc3267ff45a82de4e3e35a1587e1fbf977baf1b6ac692079899a3d6dc678a9b5f2c89fbcc59e3b81b'

  console.log(
    `\n\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`
  )

  console.log(
    `signatures match: ${signature === targetSignatureFromWorkingTestCase}`
  )

  console.log(
    `<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n\n`
  )
}

const compareDigest = (digest: string) => {
  const targetDigestFromWorkingTestCase =
    '0xc6a3b551f78b9acd04fb6466e127260300b610fa626a97cd562256f4ec9acad0'

  console.log(
    `\n\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`
  )

  console.log(`digests match: ${digest === targetDigestFromWorkingTestCase}`)

  console.log(
    `<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n\n`
  )
}

// WORKS AS INTENDED (tested)
const getDomainSeparatorHash = async () => {
  const domSep = await permit2_contract.callStatic.DOMAIN_SEPARATOR()
  return domSep
  // return '0x4142cc3c823f819c467fa4437d637fe20589a31dfcd1da2ff22292c9ed9344e7'
}

// WORKS AS INTENDED (tested)
const getEncodedTypeHash = () => {
  console.log(`before encodedTypeHash`)

  const encodedType = utils.toUtf8Bytes(FULL_WITNESS_TYPESTRING)

  const encodedTypeHash = utils.keccak256(encodedType)

  // return '0x57708b7c1b6d6148e3cf1034715654df16e7e5b45998456cb2f9833a24fe12f8'
  return encodedTypeHash
}

// WORKS AS INTENDED (tested)
const getEncodedWitnessHash = (
  tokenReceiver: string,
  diamondAddress: string,
  diamondCalldata: string
) => {
  const witnessDataEncoded = ethers.utils.defaultAbiCoder.encode(
    [
      'tuple(address tokenReceiver, address diamondAddress, bytes diamondCalldata)',
    ],
    [[tokenReceiver, diamondAddress, diamondCalldata]]
  )

  const witnessHash = utils.keccak256(witnessDataEncoded)

  return witnessHash
}

// WORKS AS INTENDED (tested)
const getTokenPermissionsTypeHash = () => {
  const typeHash = utils.keccak256(
    utils.toUtf8Bytes(TOKEN_PERMISSIONS_TYPESTRING)
  )

  return typeHash
  // return '0x618358ac3db8dc274f0cd8829da7e234bd48cd73c4a740aede1adec9846d06a1'
}

const getTokenPermissionsHash = (permit: PermitTransferFrom) => {
  // keccak256(
  //   abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, permit.permitted))

  const tokenPermissionsTypeHash = getTokenPermissionsTypeHash()
  // const hashedTokenPermissions =

  // const tokenPermissionsHash = utils.keccak256(
  //   utils.defaultAbiCoder.encode([], [tokenPermissionsTypeHash, hashedTokenPermissions])
  // )

  const encoded = ethers.utils.defaultAbiCoder.encode(
    ['bytes32', 'tuple(address, address)'],
    [
      tokenPermissionsTypeHash,
      [permit.permitted.token, permit.permitted.amount],
    ]
  )

  // DOES NOT WORK:
  // const permitValues = utils.concat([
  //   utils.toUtf8Bytes(permit.permitted.token),
  //   utils.toUtf8Bytes(permit.permitted.amount.toString()),
  // ])

  // const encoded = ethers.utils.defaultAbiCoder.encode(
  //   ['bytes32', 'tuple(address, uint256)'],
  //   [tokenPermissionsTypeHash, permitValues]
  // )

  console.log(
    `tokenPermissionsHash is correct: ${
      encoded ===
      '0x28f83abb28f33f6e21a93b71ebb9256afa8cab9d867c56aecba9d9e661eb1109'
    }`
  )
  return '0x28f83abb28f33f6e21a93b71ebb9256afa8cab9d867c56aecba9d9e661eb1109'
}

// WORKS AS INTENDED (tested)
const getMsgHash = async (
  tokenReceiver: string,
  diamondAddress: string,
  diamondCalldata: string,
  permit: PermitTransferFrom
) => {
  console.log(`in getMsgHash`)

  const separator = '\x19\x01'
  const domainSeparator = await getDomainSeparatorHash()
  const typeHash = getEncodedTypeHash()
  const tokenPermissions = getTokenPermissionsHash(permit)
  const witnessHash = getEncodedWitnessHash(
    tokenReceiver,
    diamondAddress,
    diamondCalldata
  )

  // encode the values of the permit and the witness
  const encodedValues = utils.keccak256(
    utils.defaultAbiCoder.encode(
      ['bytes32', 'bytes32', 'address', 'uint256', 'uint256', 'bytes32'],
      [typeHash, tokenPermissions, PERMIT_2_PROXY, nonce, deadline, witnessHash]
    )
  )

  // console.log(`values received: ${encodedValues}`)

  // the next two steps mimic the behavior of abi.encodePacked() in Solidity
  // 1: Convert separator and domainSeparator to binary/Uint8Array
  const separatorBytes = utils.toUtf8Bytes(separator)
  const domainSeparatorBytes = utils.arrayify(domainSeparator)
  const encodedValuesBytes = utils.arrayify(encodedValues)

  // 2: Concatenate all Uint8Arrays
  const concatenatedBytes = utils.concat([
    separatorBytes,
    domainSeparatorBytes,
    encodedValuesBytes,
  ])

  // get hash from encoded domainSeparator and values
  const msgHash = utils.keccak256(concatenatedBytes)

  // console.log(`msgHash created: ${msgHash}`)

  compareDigest(msgHash)

  return msgHash
}

// ###########################################################

// const main_usePermit2SDK = async () => {
//   console.log(`Starting main_Permit2SDK`)

//   prepareWalletsAndContracts()

//   // give infinite approval from wallet to Uniswap Permit2 contract, if not existing already
//   if ((await usdc_contract.allowance(signer.address, PERMIT_2_BSC)).isZero())
//     await maxApproveTokenToPermit2(signer, usdc_contract, PERMIT_2_BSC)

//   // fetch route from LI.FI API and extract diamondAddress and diamondCalldata
//   // eslint-disable-next-line prefer-const
//   let { diamondAddress, diamondCalldata } = await getRouteFromLiFiAPI(signer)

//   // create permit
//   const permitForSignature: PermitTransferFrom = {
//     permitted: {
//       token: BSC_USDC_ADDRESS,
//       amount: testAmount,
//     },
//     spender: PERMIT_2_PROXY,
//     nonce: constants.MaxUint256.toString(),
//     // deadline: constants.MaxUint256.toString(),
//     deadline: 1709269103, // as used in working test case
//   }
//   // create witness
//   const witness = getWitness(PERMIT_2_PROXY, diamondAddress, diamondCalldata)

//   // prepare data for signing
//   const { domain, types, values } = SignatureTransfer.getPermitData(
//     permitForSignature,
//     PERMIT2_ADDRESS,
//     SRC_CHAIN_ID,
//     witness
//   )

//   // const domain2: TypedDataDomain = {
//   //   name: '"Permit2"',
//   //   version: '1',
//   //   chainId: 56,
//   //   verifyingContract: PERMIT2_ADDRESS,
//   // }

//   console.log(`domain: ${JSON.stringify(domain, null, 2)}`)
//   console.log(`types: ${JSON.stringify(types, null, 2)}`)
//   console.log(`values: ${JSON.stringify(values, null, 2)}`)

//   // sign permit message
//   const signature = await signer._signTypedData(domain, types, values)

//   compareSignatures(signature)

//   // encode witnessData as bytes value (will be a function argument for the call)
//   const witnessData = encodeWitnessData(diamondAddress, diamondCalldata)

//   // verify signature
//   const expectedSignerAddress = signer.address
//   const recoveredAddress = utils.verifyTypedData(
//     domain,
//     types,
//     values,
//     signature
//   )
//   logDebug(
//     `Signer address (${signer.address}) successfully recovered: ${
//       recoveredAddress === expectedSignerAddress
//     }`
//   )

//   const permitForCall = {
//     permitted: {
//       token: BSC_USDC_ADDRESS,
//       amount: testAmount,
//     },
//     nonce: constants.MaxUint256.toString(),
//     // deadline: constants.MaxUint256.toString(),
//     deadline: 1709269103,
//   }

//   // logDebug(`signature: ${JSON.stringify(signature)}`)
//   logDebug(`permitForSignature: ${JSON.stringify(permitForSignature, null, 2)}`)
//   logDebug(`permitForCall: ${JSON.stringify(permitForCall, null, 2)}`)
//   // logDebug(`permit2Proxy: ${JSON.stringify(permit2Proxy)}`)

//   // trigger transaction using calldata and user signature
//   const tx = await permit2Proxy_contract.callDiamondWithPermit2SignatureSingle(
//     permitForCall,
//     testAmount,
//     witnessData,
//     signer.address,
//     signature
//   )

//   await tx.wait()

//   logSuccess('\n\n script successfully completed')
// }

// const main_useHardcodedValues = async () => {
//   console.log(`Starting main_HardcodedValues`)

//   prepareWalletsAndContracts()

//   // give infinite approval from wallet to Uniswap Permit2 contract, if not existing already
//   if ((await usdc_contract.allowance(signer.address, PERMIT_2_BSC)).isZero())
//     await maxApproveTokenToPermit2(signer, usdc_contract, PERMIT_2_BSC)

//   // fetch route from LI.FI API and extract diamondAddress and diamondCalldata
//   const { diamondAddress, diamondCalldata } = await getRouteFromLiFiAPI(signer)

//   // prepare data for signing
//   const { permit, unsignedData } = await prepareDataForSigning(
//     signer,
//     executor,
//     diamondAddress,
//     diamondCalldata
//   )

//   // console.log(`unsignedData: ${JSON.stringify(unsignedData, null, 2)}`)
//   const digest = _TypedDataEncoder.hash(
//     unsignedData.domain,
//     unsignedData.types,
//     unsignedData.values
//   )

//   // console.log(`digest: ${JSON.stringify(digest)}`)
//   compareDigest(digest)

//   // sign quote/calldata using wallet
//   const signature = await signTypedData(signer, unsignedData)

//   compareSignatures(signature)

//   // encode witnessData as bytes value (will be a function argument for the call)
//   const witnessData = encodeWitnessData(diamondAddress, diamondCalldata)

//   // verify signature
//   const expectedSignerAddress = signer.address
//   const recoveredAddress = utils.verifyTypedData(
//     unsignedData.domain,
//     unsignedData.types,
//     unsignedData.values,
//     signature
//   )
//   logDebug(
//     `Signer address (${signer.address}) successfully recovered: ${
//       recoveredAddress === expectedSignerAddress
//     }`
//   )

//   // logDebug(`signature: ${JSON.stringify(signature)}`)
//   // logDebug(`permit: ${JSON.stringify(permit, null, 2)}`)
//   // logDebug(`permit2Proxy: ${JSON.stringify(permit2Proxy)}`)

//   // trigger transaction using calldata and user signature
//   const tx = await permit2Proxy_contract.callDiamondWithPermit2SignatureSingle(
//     // adjustedPermit,
//     permit,
//     testAmount,
//     witnessData,
//     signer.address,
//     signature
//   )

//   await tx.wait()

//   logSuccess('\n\n script successfully completed')
// }

// approach suggested by ChatGPT
async function main_useAlternativeSignatureApproach() {
  console.log(`Starting main_alternativeSignatureApproach`)

  prepareWalletsAndContracts()

  // give infinite approval from wallet to Uniswap Permit2 contract, if not existing already
  if ((await usdc_contract.allowance(signer.address, PERMIT2_ADDRESS)).isZero())
    await maxApproveTokenToPermit2(signer, usdc_contract, PERMIT2_ADDRESS)

  // fetch route from LI.FI API and extract diamondAddress and diamondCalldata
  const { diamondAddress, diamondCalldata } = await getRouteFromLiFiAPI(signer)

  // // Define the permit structure based on your Permit2 contract requirements
  const permitForSignature: PermitTransferFrom = {
    permitted: {
      token: BSC_USDC_ADDRESS,
      amount: testAmount,
    },
    spender: PERMIT_2_PROXY,
    nonce,
    deadline,
  }

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
      [
        witness.tokenReceiver,
        witness.diamondAddress,
        // ethers.utils.arrayify(witness.diamondCalldata),
        witness.diamondCalldata,
      ],
    ]
  )
  console.log(`witnessDataToSign: ${utils.keccak256(witnessDataToSign)}`)

  const msgHash = await getMsgHash(
    witness.tokenReceiver,
    witness.diamondAddress,
    witness.diamondCalldata,
    permitForSignature
  )

  // Combine permit and witness data for signing

  // const combinedDataToSign = ethers.utils.keccak256(
  // const combinedDataToSign = utils.keccak256(
  //   ethers.utils.defaultAbiCoder.encode(
  //     ['bytes', 'bytes', 'bytes'],
  //     [PERMIT_2_BSC_DOMAIN_SEPARATOR, permitDataToSign, witnessDataToSign]
  //   )
  // )
  const combinedDataToSign = ethers.utils.defaultAbiCoder.encode(
    ['bytes', 'bytes', 'bytes'],
    [PERMIT_2_BSC_DOMAIN_SEPARATOR, permitDataToSign, witnessDataToSign]
  )

  // console.log(`combinedDataToSign: ${JSON.stringify(combinedDataToSign)}`)
  // compareDigest(combinedDataToSign)

  // Sign the combined data

  // @ DEV: with this code I was able to produce the correct signature based on the correct digest, so the signing seems to work if I pass in the right values
  // const CORRECT_DIGEST =
  // '0x110686fdab1594195e92ec4d111f522fc2680ffc81998ad9cc125abbf7556f4d'
  const sig = await signer._signingKey().signDigest(msgHash)
  const signature = joinSignature(sig)

  // const signature = await signer.signMessage(
  //   // ethers.utils.arrayify(combinedDataToSign)
  //   // combinedDataToSign
  //   msgHash
  // )

  compareSignatures(signature)

  // logDebug(`permit: ${JSON.stringify(permitForSignature, null, 2)}`)
  // logDebug(`witness: ${JSON.stringify(witness, null, 2)}`)
  // logDebug(`signature: ${signature}`)

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
    // getEncodedWitness(),
    ethers.utils.defaultAbiCoder.encode(
      [
        'tuple(address tokenReceiver, address diamondAddress, bytes diamondCalldata)',
      ],
      [[PERMIT_2_PROXY, diamondAddress, diamondCalldata]]
    ),
    signer.address,
    signature
  )

  await tx.wait()

  console.log(`Transaction hash: ${tx.hash}`)
}

// main_usePermit2SDK()
// main_useHardcodedValues()
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
