import {
  http,
  createPublicClient,
  parseAbi,
  Hex,
  parseUnits,
  createWalletClient,
  PublicClient,
} from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { defineCommand, runMain } from 'citty'
import { PermitTransferFrom, SignatureTransfer } from '@uniswap/Permit2-sdk'

// Sample Transfer:
// sent:
//   https://arbiscan.io/tx/0x8d0caf2b4fda6688b5ab36254632f6b6412cf25f0f262689ed41a2a21fe489f1
// status:
//   https://scan.li.fi/tx/0x8d0caf2b4fda6688b5ab36254632f6b6412cf25f0f262689ed41a2a21fe489f1
// received:
//   https://polygonscan.com/tx/0x5dda19403942912027ef5e941e844de3a2a65b0c5a4173e3d388a71a54e5e635

const USDT_ADDRESS = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
const PERMIT2_PROXY_ADDRESS = '0xA3C7a31a2A97b847D967e0B755921D084C46a742'
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

/**
 * Get the nonce from the PERMIT2 contract
 */
const getNonceForAddress = async (
  client: PublicClient,
  address: `0x${string}`
): Promise<bigint> => {
  const permit2ProxyAbi = parseAbi([
    'function nextNonce(address owner) external view returns (uint256)',
  ])

  return client.readContract({
    address: PERMIT2_PROXY_ADDRESS,
    abi: permit2ProxyAbi,
    functionName: 'nextNonce',
    args: [address],
  })
}

/**
 * Generate permit data
 */
const getPermitData = async (params: {
  userAddress: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
  deadline: bigint
}) => {
  const client = createPublicClient({
    chain: arbitrum,
    transport: http(),
  })

  // Get latest block
  const block = await client.getBlock()
  const _deadline = block.timestamp + params.deadline
  const nonce = await getNonceForAddress(client, params.userAddress)

  // build hash
  const permitTransferFrom: PermitTransferFrom = {
    permitted: {
      token: params.tokenAddress,
      amount: params.amount,
    },
    nonce,
    spender: PERMIT2_PROXY_ADDRESS,
    deadline: _deadline,
  }
  const msgHash: `0x${string}` = SignatureTransfer.hash(
    permitTransferFrom,
    PERMIT2_ADDRESS,
    arbitrum.id
  ) as `0x${string}`

  const transferFromData: [[`0x${string}`, bigint], bigint, bigint] = [
    [params.tokenAddress, params.amount],
    nonce,
    _deadline,
  ]

  return {
    msgHash,
    transferFromData,
  }
}

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

    // Setup a signer account
    const account = privateKeyToAccount(SIGNER_PRIVATE_KEY)

    // Get calldata to bridge USDT from LIFI API
    const url =
      'https://li.quest/v1/quote?fromChain=ARB&toChain=POL&fromToken=0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9&toToken=0xc2132D05D31c914a87C6611C10748AEb04B58e8F&fromAddress=0xb9c0dE368BECE5e76B52545a8E377a4C118f597B&toAddress=0xb9c0dE368BECE5e76B52545a8E377a4C118f597B&fromAmount=5000000'
    const options = { method: 'GET', headers: { accept: 'application/json' } }
    const lifiResp = await fetch(url, options)
    const calldata = (await lifiResp.json()).transactionRequest.data

    // Get Hash
    const permitData = await getPermitData({
      userAddress: account.address,
      tokenAddress: USDT_ADDRESS,
      amount: parseUnits('5', 6),
      deadline: 1200n, // 20min
    })
    console.log(permitData)

    // Sign the message hash
    const signature = await sign({
      hash: permitData.msgHash,
      privateKey: SIGNER_PRIVATE_KEY,
      to: 'hex',
    })
    console.log('signature', signature)

    // Instantiate the executor account and a WRITE enabled client
    const executorAccount = privateKeyToAccount(SIGNER_PRIVATE_KEY)
    const walletClient = createWalletClient({
      account: executorAccount,
      chain: arbitrum,
      transport: http(),
    })
    const tx = await walletClient.writeContract({
      address: PERMIT2_PROXY_ADDRESS,
      abi: permit2ProxyAbi,
      functionName: 'callDiamondWithPermit2',
      args: [calldata, permitData.transferFromData, signature],
    })
    console.log(`Transfers submitted in tx: ${tx}`)
  },
})

runMain(main)
