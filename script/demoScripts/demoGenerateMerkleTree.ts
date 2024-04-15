import MerkleTree from 'merkletreejs'
import claimsFile from '../resources/gasRebates.json'
import fs from 'fs'
import { keccak256, defaultAbiCoder } from 'ethers/lib/utils'

const OUTPUT_PATH = './script/output/outputMerkleProofs.json'

// input types
interface Rebate {
  [account: string]: string
}
interface GasRebates {
  [network: string]: Rebate
}

// output types
interface Claim {
  account: string
  amount: string
}
interface ClaimWithProof extends Claim {
  merkleProof: string[]
}

interface ClaimsPerNetwork {
  [network: string]: {
    merkleRoot: string
    accounts: ClaimWithProof[]
  }
}

const createMerkleTree = (claims: Claim[]) => {
  // For each element : concatenate the two hex buffers
  // to a single one as this keccak256 implementation only
  // expects one input
  const leafNodes = claims.map((claim) =>
    keccak256(
      Buffer.concat([
        Buffer.from(claim.account.replace('0x', ''), 'hex'),
        Buffer.from(claim.amount.replace('0x', ''), 'hex'),
      ])
    )
  )

  // create merkle tree from leafNodes
  const merkleTree = new MerkleTree(leafNodes, keccak256, { sortPairs: true })

  return { merkleTree, leafNodes }
}

function getProof(
  claim: Claim,
  leafNodes: string[],
  tree: MerkleTree,
  allClaims: Claim[]
) {
  // find index of the claim
  const index = allClaims.findIndex(
    (item) => item.account === claim.account && item.amount === claim.amount
  )

  // throw error if claim could not be found
  if (index === -1)
    throw Error(`could not find merkle proof for account ${claim.account}`)

  // return merkle proof for claim
  return tree.getHexProof(leafNodes[index])
}

const parseAccounts = (accounts: Rebate): Claim[] => {
  return Object.entries(accounts).map(([account, amount]) => {
    return {
      account,
      amount: defaultAbiCoder.encode(['uint256'], [amount]),
    }
  })
}

const processClaims = (
  claims: Claim[],
  leafNodes: string[],
  tree: MerkleTree
): ClaimWithProof[] => {
  return claims.map((claim) => {
    const merkleProof = getProof(claim, leafNodes, tree, claims)
    return {
      account: claim.account,
      amount: claim.amount,
      merkleProof,
    }
  })
}

const processNetwork = (
  network: string,
  claims: Rebate,
  output: ClaimsPerNetwork
) => {
  // parse accounts into array
  const claimsArray = parseAccounts(claims)

  // create merkle tree
  const { merkleTree, leafNodes } = createMerkleTree(claimsArray)

  // iterate over all claims and get merkle proof for each claim
  const claimsWithProof = processClaims(claimsArray, leafNodes, merkleTree)

  // create formatted output
  output[network] = {
    merkleRoot: merkleTree.getHexRoot().toString(),
    accounts: claimsWithProof,
  }
}

const main = async () => {
  const output: ClaimsPerNetwork = {}

  // parse input file
  const claimsJson: GasRebates = claimsFile
  if (!claimsJson) throw Error('Input file invalid')

  // iterate over all networks
  Object.entries(claimsJson).forEach(([network, accounts]) => {
    console.log(`Now parsing network: ${network}`)
    processNetwork(network, accounts, output)
  })

  // write formatted output to file
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2))
  console.log(`Output file written to ${OUTPUT_PATH}`)
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
