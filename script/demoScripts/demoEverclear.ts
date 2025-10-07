import {
  getContract,
  parseUnits,
  Narrow,
  zeroAddress,
  Abi,
  parseAbi,
  AbiParametersToPrimitiveTypes,
  Hex,
  decodeFunctionData,
  Address
} from 'viem'
import { randomBytes } from 'crypto'
import { config } from 'dotenv'
import { ERC20__factory as ERC20 } from '../../typechain/factories/ERC20__factory'
import { EverclearFacet__factory as EverclearFacet } from '../../typechain/factories/EverclearFacet.sol/EverclearFacet__factory'
import { ensureBalance, ensureAllowance, executeTransaction, setupEnvironment, type SupportedChain, addressToBytes32RightPadded } from './utils/demoScriptHelpers'
import everclearFacetArtifact from '../../out/EverclearFacet.sol/EverclearFacet.json'

config()

const EVERCLEAR_FACET_ABI = everclearFacetArtifact.abi as Abi


// Defining the ABI structure for the newIntent function based on the user's *asserted* V1 signature
const NEW_INTENT_ABI_STRING = [
  `function newIntent(uint32[] destinations, address receiver, address inputAsset, address outputAsset, uint256 amount, uint24 maxFee, uint48 ttl, bytes data, (uint256 fee, uint256 deadline, bytes sig) feeParams)`
] as const;

// Using viem's parseAbi to convert the human-readable ABI into the structured ABI
const NEW_INTENT_ABI = parseAbi(NEW_INTENT_ABI_STRING);

// Define the expected types of the arguments returned by viem for clarity
// Note: viem returns bigint for uint256 and often for smaller integers (like uint48) in tuples.
type NewIntentArgs = AbiParametersToPrimitiveTypes<typeof NEW_INTENT_ABI[0]['inputs']>;


/**
* Decodes the raw calldata (including the selector) into structured function arguments.
* NOTE: This decoder forces the use of the newIntent signature, even though the selector (0xb4c20477)
* typically maps to newOrder and the calldata structure looks like a newOrder call.
* This decoding is likely to fail or produce nonsensical values because the calldata structure 
* probably does not match the newIntent ABI encoding.
* @param fullCalldata The complete hex string (e.g., "0xb4c20477...")
* @returns An object containing the decoded parameters, or null if decoding fails.
*/
function decodeNewIntentCalldata(fullCalldata: string) {
  const data = fullCalldata as Hex;

  try {
      // Decode the parameters using viem's decodeFunctionData
      const { args } = decodeFunctionData({
          abi: NEW_INTENT_ABI,
          data: data,
      });

      console.log("args")
      console.log(args)

      // Destructure args according to the NewIntentArgs type
      const [
          _destinations, 
          _receiver, 
          _inputAsset, 
          _outputAsset, 
          _amount, 
          _maxFee, 
          _ttl, 
          _data, 
          _feeParamsTuple
      ] = args as NewIntentArgs;

      console.log("_destinations")
      console.log(_destinations)
      console.log("_receiver")
      console.log(_receiver)
      console.log("_inputAsset")
      console.log(_inputAsset)
      console.log("_outputAsset")
      console.log(_outputAsset)
      console.log("_amount")
      console.log(_amount)
      console.log("_maxFee")
      console.log(_maxFee)
      console.log("_ttl")
      console.log(_ttl)
      console.log("_data")
      console.log(_data)
      console.log("_feeParamsTuple")
      console.log(_feeParamsTuple)
      console.log("_feeParamsTuple.fee")
      console.log(_feeParamsTuple.fee)
      console.log("_feeParamsTuple.deadline")
      console.log(_feeParamsTuple.deadline)
      console.log("_feeParamsTuple.sig")
      console.log(_feeParamsTuple.sig)

      // Extracting parameters based on the function signature
      const output = {
          _destinations: _destinations as number[], // Assuming array of uint32 decodes to number[]
          _receiver: _receiver as Address,
          _inputAsset: _inputAsset as Address,
          _outputAsset: _outputAsset as Address,
          _amount: _amount,      // bigint
          _maxFee: _maxFee,      // number/bigint
          _ttl: _ttl,            // number/bigint
          _data: _data,          // Hex string
          _feeParams: {
              fee: _feeParamsTuple.fee,          // bigint
              deadline: _feeParamsTuple.deadline, // bigint
              sig: _feeParamsTuple.sig,          // Hex string
          }
      };

      return output;

  } catch (e) {
      // We expect this to fail or yield incorrect results due to the signature/selector mismatch
      throw new Error("Decoding Failed: The calldata structure does not match the provided signature.");
  }
}

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = "arbitrum"
  const destinationChainId = 10 // Optimism Mainnet

  const { client, publicClient, walletAccount, lifiDiamondAddress, lifiDiamondContract } = await setupEnvironment(srcChain, EVERCLEAR_FACET_ABI)
  const signerAddress = walletAccount.address

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as `0x${string}` // USDC on Arbitrum

  // === Instantiate contracts ===
  const srcTokenContract = getContract({
    address: SRC_TOKEN_ADDRESS,
    abi: ERC20.abi,
    client: publicClient
  })

  const srcTokenName = await srcTokenContract.read.name() as string
  const srcTokenSymbol = await srcTokenContract.read.symbol() as string
  const srcTokenDecimals = await srcTokenContract.read.decimals() as bigint
  const amount = parseUnits('1', Number(srcTokenDecimals)); // 10 * 1e{source token decimals}

  // // docs: https://docs.everclear.org/developers/api#post-routes-quotes
  const quoteResp = await fetch(
    `https://api.everclear.org/routes/quotes`,
    { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        "origin": "42161",
        "destinations": [
          "10"
        ],
        "inputAsset": SRC_TOKEN_ADDRESS,
        "amount": "500000000",
        "to": "0x2b2c52B1b63c4BfC7F1A310a1734641D8e34De62"
      })
    }
  )
  const quoteData = await quoteResp.json()

  console.log("quoteData")
  console.log(quoteData)

  const createIntentResp = await fetch(
    `https://api.everclear.org/intents`,
    { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        "origin": "42161",
        "destinations": [
          "10"
        ],
        "to": "0x2b2c52B1b63c4BfC7F1A310a1734641D8e34De62",
        "inputAsset": SRC_TOKEN_ADDRESS,
        "amount": "500000",
        // This 'callData' would be the ABI-encoded transaction data for the
        // `startBridgeTokensViaEverclear` function on your LIFI Diamond.
        // It would contain the `ILiFi.BridgeDataStruct` and `EverclearData` structs.
        "callData": "0x",
        // This 'maxFee' would come from the quote API response, e.g., quoteData.totalFeeBps.
        "maxFee": "100000", // 
        // Permit2 is required for gasless transactions. You would need to sign
        // this data off-chain using a wallet, not a simple API call.
        // The rest of the fields that the API requires
        "order_id": `0x${randomBytes(32).toString('hex')}`
      })
    }
  )
  const createIntentData = await createIntentResp.json()

  console.log("createIntentData")
  console.log(createIntentData)

  console.log("createIntentData.data")
  console.log(createIntentData.data)

  console.info(`Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> {DESTINATION CHAIN NAME}`)
  console.info(`Connected wallet address: ${signerAddress}`)

  await ensureBalance(srcTokenContract, signerAddress, amount)

  await ensureAllowance(srcTokenContract, signerAddress, lifiDiamondAddress, amount, publicClient)


  // // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    // Edit fields as needed
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'everclear',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

//   struct EverclearData {
//     bytes32 receiverAddress;
//     bytes32 outputAsset;
//     uint24 maxFee;
//     uint48 ttl;
//     bytes data;
//     uint256 fee;
//     uint256 deadline;
//     bytes sig;
// }

  const decodedNewIntentData = decodeNewIntentCalldata(createIntentData.data);
  const everclearData: EverclearFacet.EverclearDataStruct = {
    receiverAddress: addressToBytes32RightPadded(signerAddress),
    outputAsset: SRC_TOKEN_ADDRESS,
    maxFee: decodedNewIntentData._maxFee,
    ttl: decodedNewIntentData._ttl,
    data: "",
    fee: decodedNewIntentData._feeParams.fee,
    deadline: decodedNewIntentData._feeParams.deadline,
    sig: decodedNewIntentData._feeParams.sig,
  }

  // // === Start bridging ===
  await executeTransaction(
    () =>
      (lifiDiamondContract as any).write.startBridgeTokensViaEverclear(
        [bridgeData, everclearData],
        // { value: fee } optional value
      ),
    'Starting bridge tokens via Everclear',
    publicClient,
    true
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
