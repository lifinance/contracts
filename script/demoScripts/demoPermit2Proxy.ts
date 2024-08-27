import {
  http,
  createPublicClient,
  parseAbi,
  Hex,
  parseUnits,
  serializeSignature,
  createWalletClient,
} from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { defineCommand, runMain } from 'citty'

const DIAMOND_ADDRESS = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const USDT_ADDRESS = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
const PERMIT2_PROXY_ADDRESS = '0x442BBFD6a4641B2b710DFfa4754081eC7502a3F7'
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const PRIVATE_KEY = `0x${process.env.PRIVATE_KEY}`

const main = defineCommand({
  meta: {
    name: 'demo-permit2',
    description: 'Demonstrate a Permit2 tx',
  },
  args: {
    signerKey: {
      type: 'string',
      description: 'Private key of signer',
      required: true,
    },
    executorKey: {
      type: 'string',
      description: 'Private key of the executor',
      required: true,
    },
  },
  async run({ args }) {
    const SIGNER_PRIVATE_KEY = `0x${args.signerKey}` as Hex
    const EXECUTOR_PRIVATE_KEY = `0x${args.executorKey}` as Hex

    // Setup the required ABIs
    const permit2Abi = parseAbi([
      'function nonceBitmap(address owner, uint256 index) external view returns (uint256 nonce)',
    ])
    const permit2ProxyAbi = parseAbi([
      'function getPermit2MsgHash(address,bytes,address,uint256,uint256,uint256) external view returns (bytes32)',
      'function callDiamondWithPermit2SignatureSingle(address,bytes,address,((address,uint256),uint256,uint256),bytes) external',
    ])

    // Setup a READ-ONLY client
    const client = createPublicClient({
      chain: arbitrum,
      transport: http(),
    })

    // Setup a signer account
    const account = privateKeyToAccount(SIGNER_PRIVATE_KEY)

    // Get calldata to bridge USDT from LIFI API
    const url =
      'https://li.quest/v1/quote?fromChain=ARB&toChain=POL&fromToken=0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9&toToken=0xc2132D05D31c914a87C6611C10748AEb04B58e8F&fromAddress=0xb9c0dE368BECE5e76B52545a8E377a4C118f597B&toAddress=0xb9c0dE368BECE5e76B52545a8E377a4C118f597B&fromAmount=5000000'
    const options = { method: 'GET', headers: { accept: 'application/json' } }
    const lifiResp = await fetch(url, options)
    const calldata = (await lifiResp.json()).transactionRequest.data

    // Get the nonce from the PERMIT2 contract
    const nonce = await client.readContract({
      address: PERMIT2_ADDRESS,
      abi: permit2Abi,
      functionName: 'nonceBitmap',
      args: [account.address, 0n],
    })

    // Get lastest block
    const block = await client.getBlock()

    // Consturct a valid message hash to sign using Permit2Proxy's utility func
    const msgHash = await client.readContract({
      address: PERMIT2_PROXY_ADDRESS,
      abi: permit2ProxyAbi,
      functionName: 'getPermit2MsgHash',
      args: [
        DIAMOND_ADDRESS,
        calldata,
        USDT_ADDRESS,
        parseUnits('5', 6),
        nonce,
        block.timestamp + 1200n,
      ],
    })
    console.log(msgHash)

    // Sign the message hash
    const rsvSig = await sign({ hash: msgHash, privateKey: SIGNER_PRIVATE_KEY })
    const signature = serializeSignature(rsvSig)
    console.log(signature)

    // Setup the parameters for the executor to call
    const tokenPermissions = [USDT_ADDRESS, parseUnits('5', 6)]
    const permit = [tokenPermissions, nonce, block.timestamp + 1200n]

    // Instantiate the executor account and a WRITE enabled client
    const executorAccount = privateKeyToAccount(EXECUTOR_PRIVATE_KEY)
    const walletClient = createWalletClient({
      account: executorAccount,
      chain: arbitrum,
      transport: http(),
    })

    // Execute using the Permit2 Proxy
    const tx = await walletClient.writeContract({
      address: PERMIT2_PROXY_ADDRESS,
      abi: permit2ProxyAbi,
      functionName: 'callDiamondWithPermit2SignatureSingle',
      args: [DIAMOND_ADDRESS, calldata, account.address, permit, signature],
    })
  },
})

runMain(main)
