import {
  getContract,
  parseUnits,
  Narrow,
  zeroAddress,
  bytesToHex
} from 'viem'
import { randomBytes } from 'crypto'
import { config } from 'dotenv'
import { ERC20__factory as ERC20 } from '../../typechain/factories/ERC20__factory'
import { UnitFacet__factory as UnitFacet } from '../../typechain/factories/UnitFacet.sol/UnitFacet__factory'
import { ensureBalance, ensureAllowance, executeTransaction, setupEnvironment, type SupportedChain } from './utils/demoScriptHelpers'

config()

// If you need to import a custom ABI, follow these steps:
// 
// First, ensure you import the relevant artifact file:
// import { exampleArtifact__factory } from '../../typechain/factories/{example artifact json file}'
//

/**
 * A universal function to decode a Base64 string to a Uint8Array.
 * Uses the global `atob` function, which is available in Bun, Node.js, Deno, and browsers.
 *
 * @param {string} b64 The Base64 encoded string.
 * @returns {Uint8Array} A Uint8Array of the decoded bytes.
 */
function base64ToBytes(b64: string): Uint8Array {
  // `atob` decodes a Base64 string into a binary string.
  const binStr = atob(b64);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  // Convert the binary string into a byte array.
  for (let i = 0; i < len; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return bytes;
}

// /**
//  * Converts a Uint8Array to a hexadecimal string.
//  * @param {Uint8Array} bytes The byte array to convert.
//  * @returns {string} The resulting hexadecimal string.
//  */
// function bytesToHex(bytes: Uint8Array): string {
//   return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
// }


/**
 * Decodes an 88-character Base64 signature string into a 65-byte Uint8Array.
 *
 * @param {string} encodedString The 88-character Base64 encoded string.
 * @returns {Uint8Array} A Uint8Array object containing the 65 decoded bytes.
 */
export function decodeSignature(encodedString: string): Uint8Array {
  if (encodedString.length !== 88) {
    throw new Error(
      `Invalid input: Expected an 88-character string, but received ${encodedString.length}.`
    );
  }

  // Use the universal `atob`-based decoding function.
  console.log('decoding signature')
  console.log(encodedString)
  const decodedBytes = base64ToBytes(encodedString);
  console.log('decoded bytes')
  console.log(decodedBytes)
  if (decodedBytes.length !== 64) {
    throw new Error(
      `Decoding error: Expected 64 bytes, but received ${decodedBytes.length}.`
    );
  }

  return decodedBytes;
}

async function main() {

  const fieldNodeB64 = "VZ67I8BoGn3prKzEWirLOgjqDGYiCXQiJiBcP5qOPEHeTOMGMIpOYE4JaY6qP6mhlG7TQe2yNE2OMsGC4X6OJA==";
  const hlNodeB64 = "Jt1kwAXxJOxB1moXWUYBIdJ3rc90lM4zOuqBcqlQ00zCKM6RmoxIOr/vG06qBDMt19klSBCPkYiazw6V4xVaaw==";
  const unitNodeB64 = "XG3TKBAuCjPx1xyX3Yws2WKUR0JOaV5iSkZlVfecibrWHP9a3HfAWriHcXNRQH2bKAfT0cbwk5ApliFxmaeXvQ==";
  
  try {
    const unitNodeBytes = decodeSignature(unitNodeB64);
    const hlNodeBytes = decodeSignature(hlNodeB64);
    const fieldNodeBytes = decodeSignature(fieldNodeB64);

    console.log('unitNodeBytes')
    console.log(unitNodeBytes.toHex())
    console.log('hlNodeBytes')
    console.log(hlNodeBytes.toHex())
    console.log('fieldNodeBytes')
    console.log(fieldNodeBytes.toHex())
  
    const allSignatures = [unitNodeBytes, hlNodeBytes, fieldNodeBytes];
    const mergedSignatures = new Uint8Array(192);
    let offset = 0;
    for (const sig of allSignatures) {
      mergedSignatures.set(sig, offset);
      offset += sig.length;
    }
    
    const hexString = bytesToHex(mergedSignatures);
  
    console.log(`✅ Success!`);
    console.log(`   Total bytes: ${mergedSignatures.length}`); // Expected: 192
    console.log(`   Final hex string for test: ${hexString}`);
    
  } catch (error) {
    console.error((error as Error).message);
  }
  // === Set up environment ===
  // const srcChain: SupportedChain = "mainnet" // Set source chain
  // const destinationChainId = 1 // Set destination chain id

  // const { client, publicClient, walletAccount, lifiDiamondAddress, lifiDiamondContract } = await setupEnvironment(srcChain, UNIT_FACET_ABI)
  // const signerAddress = walletAccount.address

  // // === Contract addresses ===
  // const SRC_TOKEN_ADDRESS = '' as `0x${string}` // Set the source token address here.

  // // If you need to retrieve a specific address from your config file 
  // // based on the chain and element name, use this helper function.
  // // 
  // // First, ensure you import the relevant config file:
  // // import config from '../../config/unit.json'
  // //
  // // Then, retrieve the address:
  // // const EXAMPLE_ADDRESS = getConfigElement(config, srcChain, 'example');
  // //

  // // === Instantiate contracts ===
  // const srcTokenContract = getContract({
  //   address: SRC_TOKEN_ADDRESS,
  //   abi: ERC20.abi,
  //   client: publicClient
  // })

  // // If you need to interact with a contract, use the following helper. 
  // // Provide the contract address, ABI, and a client instance to initialize 
  // // the contract for both read and write operations.
  // //
  // // const exampleContract = getContract({
  // //   address: EXAMPLE_ADDRESS,
  // //   abi: EXAMPLE_ABI,
  // //   client
  // // })
  // //

  // const srcTokenName = await srcTokenContract.read.name() as string
  // const srcTokenSymbol = await srcTokenContract.read.symbol() as string
  // const srcTokenDecimals = await srcTokenContract.read.decimals() as bigint
  // const amount = parseUnits('10', Number(srcTokenDecimals)); // 10 * 1e{source token decimals}

  // console.info(`Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> {DESTINATION CHAIN NAME}`)
  // console.info(`Connected wallet address: ${signerAddress}`)

  // await ensureBalance(srcTokenContract, signerAddress, amount)

  // await ensureAllowance(srcTokenContract, signerAddress, lifiDiamondAddress, amount, publicClient)

  // // === In this part put necessary logic usually it's fetching quotes, estimating fees, signing messages etc. ===




  // // === Prepare bridge data ===
  // const bridgeData: ILiFi.BridgeDataStruct = {
  //   // Edit fields as needed
  //   transactionId: `0x${randomBytes(32).toString('hex')}`,
  //   bridge: 'unit',
  //   integrator: 'ACME Devs',
  //   referrer: zeroAddress,
  //   sendingAssetId: SRC_TOKEN_ADDRESS,
  //   receiver: signerAddress,
  //   destinationChainId,
  //   minAmount: amount,
  //   hasSourceSwaps: false,
  //   hasDestinationCall: false,
  // }

  // const unitData: UnitFacet.UnitDataStruct = {
  //   // Add your specific fields for Unit here.
  // }

  // // === Start bridging ===
  // await executeTransaction(
  //   () =>
  //     lifiDiamondContract.write.startBridgeTokensViaUnit(
  //       [bridgeData, unitData],
  //       // { value: fee } optional value
  //     ),
  //   'Starting bridge tokens via Unit',
  //   publicClient,
  //   true
  // )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
