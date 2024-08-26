import { http, createPublicClient, parseAbi } from 'viem'
import { arbitrum } from 'viem/chains'
import dotenv from 'dotenv'
dotenv.config()

const PERMIT2_PROXY_ADDRESS = '0x442BBFD6a4641B2b710DFfa4754081eC7502a3F7'

const main = async () => {
  const abi = parseAbi([
    'function getPermit2MsgHash(address,bytes,address,uint256,uint256,uint256)',
  ])

  const client = createPublicClient({
    chain: arbitrum,
    transport: http(),
  })

  // Get calldata to bridge UNI from LIFI API

  // Get nonce

  //

  // Pass args and figure out msg hash
  const msgHash = await client.readContract({
    address: PERMIT2_PROXY_ADDRESS,
    abi,
    functionName: 'getPermi2MsgHash',
    args: [],
  })

  // Sign msg hash

  // Call proxy with signature
}

main()
  .then(() => {
    console.log('Done!')
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
