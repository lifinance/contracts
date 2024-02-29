import { ethers } from 'ethers'
import {
  Permit2Proxy,
  IPermit2,
  ERC20Permit,
  Permit2Proxy,
  Permit2Proxy__factory,
} from '../../typechain' // Adjust the import path according to your setup
import { ERC20__factory } from '../../typechain/factories/ERC20'
import dotenv from 'dotenv'
dotenv.config()

// Configuration
const rpcUrl = process.env.ETH_NODE_URI_BSC
const privateKeySigner = process.env.PRIVATE_KEY
const privateKeyExecutor = process.env.PRIVATE_KEY_EXECUTOR
const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
const signer = new ethers.Wallet(privateKeySigner as string).connect(provider)
const executor = new ethers.Wallet(privateKeyExecutor as string).connect(
  provider
)

const permit2ProxyAddress = '0xA445b84904612Bf2d17F56FBD6759B65F7ba51eA'
const permit2Address = 'P0x000000000022D473030F116dDEE9F6B43aC78BA3'
const tokenAddress = 'TOKEN_CONTRACT_ADDRESS' // The address of the ERC20 token contract implementing EIP-2612

// Initialize contract instances
const permit2Proxy = new ethers.Contract(
  permit2ProxyAddress,
  Permit2Proxy__factory.abi,
  wallet
) as Permit2Proxy
const token = new ethers.Contract(
  tokenAddress,
  ERC20__factory.abi,
  wallet
) as ERC20Permit

async function main() {
  const owner = wallet.address // Wallet address is the token owner
  const amount = ethers.utils.parseUnits('1.0', 18) // Amount of tokens to bridge, adjust for decimals
  const deadline = Math.floor(Date.now() / 1000) + 3600 // Signature deadline, 1 hour from now
  const diamondAddress = 'DIAMOND_CONTRACT_ADDRESS' // Your LI.FI diamond contract address
  const diamondCalldata = '0x' // Encoded function call to your diamond contract

  // Get nonce for EIP-2612 permit
  const nonce = await token.nonces(owner)

  // Construct the permit message
  const domain = {
    name: await token.name(),
    version: '1',
    chainId: (await provider.getNetwork()).chainId,
    verifyingContract: token.address,
  }
  const types = {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  }
  const message = {
    owner,
    spender: permit2Proxy.address,
    value: amount.toString(),
    nonce: nonce.toString(),
    deadline,
  }

  // Sign the permit message
  const signature = await wallet._signTypedData(domain, types, message)
  const { v, r, s } = ethers.utils.splitSignature(signature)

  // Call Permit2Proxy to execute a gasless transaction
  const tx = await permit2Proxy.callDiamondWithEIP2612Signature(
    tokenAddress,
    owner,
    amount,
    deadline,
    v,
    r,
    s,
    diamondAddress,
    ethers.utils.arrayify(diamondCalldata) // Ensure diamondCalldata is passed as a bytes array
  )

  console.log(`Transaction hash: ${tx.hash}`)
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
