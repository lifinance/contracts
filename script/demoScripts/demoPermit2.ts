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
import { PermitTransferFrom, SignatureTransfer } from '@uniswap/Permit2-sdk'

const USDT_ADDRESS = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
const PERMIT2_PROXY_ADDRESS = '0xA3C7a31a2A97b847D967e0B755921D084C46a742'
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

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
  },
  async run({ args }) {
    const SIGNER_PRIVATE_KEY = `0x${args.signerKey}` as Hex

    // Setup the required ABI
    const permit2ProxyAbi = parseAbi([
      'function callDiamondWithPermit2(bytes,((address,uint256),uint256,uint256),bytes) external',
      'function nextNonce(address owner) external view returns (uint256)',
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
      address: PERMIT2_PROXY_ADDRESS,
      abi: permit2ProxyAbi,
      functionName: 'nextNonce',
      args: [account.address],
    })

    // Get latest block
    const block = await client.getBlock()
    const deadline = block.timestamp + 1200n // 20 min deadline,

    // build hash
    const permitTransferFrom: PermitTransferFrom = {
      permitted: {
        token: USDT_ADDRESS,
        amount: parseUnits('5', 6),
      },
      nonce,
      spender: PERMIT2_PROXY_ADDRESS,
      deadline,
    }
    const msgHash = SignatureTransfer.hash(
      permitTransferFrom,
      PERMIT2_ADDRESS,
      arbitrum.id
    ) as `0x${string}`
    console.log(msgHash)

    // Sign the message hash
    const rsvSig = await sign({ hash: msgHash, privateKey: SIGNER_PRIVATE_KEY })
    const signature = serializeSignature(rsvSig)
    console.log('signature', signature)

    // Instantiate the executor account and a WRITE enabled client
    const executorAccount = privateKeyToAccount(SIGNER_PRIVATE_KEY)
    const walletClient = createWalletClient({
      account: executorAccount,
      chain: arbitrum,
      transport: http(),
    })

    // Execute using the Permit2 Proxy
    const tx = await walletClient.writeContract({
      address: PERMIT2_PROXY_ADDRESS,
      abi: permit2ProxyAbi,
      functionName: 'callDiamondWithPermit2',
      args: [
        calldata,
        [[USDT_ADDRESS as `0x${string}`, parseUnits('5', 6)], nonce, deadline],
        signature,
      ],
    })
    console.log(`Transfers submitted in tx: ${tx}`)
  },
})

runMain(main)
