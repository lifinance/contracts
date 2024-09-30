import { constants, Contract } from 'ethers'
import { Fragment, FunctionFragment } from 'ethers/lib/utils'
import { ethers } from 'hardhat'
import { IDiamondCut, IDiamondLoupe } from '../../typechain'

export function getSelectors(contract: Contract): string[] {
  const selectors = contract.interface.fragments.reduce(
    (acc: string[], val: Fragment) => {
      if (val.type === 'function') {
        const sig = contract.interface.getSighash(val as FunctionFragment)
        acc.push(sig)
        return acc
      } else {
        return acc
      }
    },
    []
  )
  return selectors
}

export const FacetCutAction = {
  Add: 0,
  Replace: 1,
  Remove: 2,
}

export async function addOrReplaceFacets(
  facets: Contract[],
  diamondAddress: string,
  initContract: string = constants.AddressZero,
  initData = '0x'
): Promise<void> {
  const loupe = <IDiamondLoupe>(
    await ethers.getContractAt('IDiamondLoupe', diamondAddress)
  )

  const cut = []
  for (const f of facets) {
    const replaceSelectors = []
    const addSelectors = []

    const selectors = getSelectors(f)

    for (const s of selectors) {
      const addr = await loupe.facetAddress(s)

      if (addr === constants.AddressZero) {
        addSelectors.push(s)
        continue
      }

      if (addr.toLowerCase() !== f.address.toLowerCase()) {
        replaceSelectors.push(s)
      }
    }

    if (replaceSelectors.length) {
      cut.push({
        facetAddress: f.address,
        action: FacetCutAction.Replace,
        functionSelectors: replaceSelectors,
      })
    }
    if (addSelectors.length) {
      cut.push({
        facetAddress: f.address,
        action: FacetCutAction.Add,
        functionSelectors: addSelectors,
      })
    }
  }

  if (!cut.length) {
    console.log('No facets to add or replace.')
    return
  }

  console.log('Adding/Replacing facet(s)...')
  await doCut(diamondAddress, cut, initContract, initData)

  console.log('Done.')
}

export async function addFacets(
  facets: Contract[],
  diamondAddress: string,
  initContract: string = constants.AddressZero,
  initData = '0x'
): Promise<void> {
  const cut = []
  for (const f of facets) {
    const selectors = getSelectors(f)

    cut.push({
      facetAddress: f.address,
      action: FacetCutAction.Add,
      functionSelectors: selectors,
    })
  }

  if (!cut.length) {
    console.log('No facets to add or replace.')
    return
  }

  console.log('Adding facet(s)...')
  await doCut(diamondAddress, cut, initContract, initData)

  console.log('Done.')
}

export async function removeFacet(
  selectors: string[],
  diamondAddress: string
): Promise<void> {
  const cut = [
    {
      facetAddress: constants.AddressZero,
      action: FacetCutAction.Remove,
      functionSelectors: selectors,
    },
  ]

  console.log('Removing facet...')
  await doCut(diamondAddress, cut, constants.AddressZero, '0x')

  console.log('Done.')
}

export async function replaceFacet(
  facet: Contract,
  diamondAddress: string,
  initContract: string = constants.AddressZero,
  initData = '0x'
): Promise<void> {
  const selectors = getSelectors(facet)

  const cut = [
    {
      facetAddress: facet.address,
      action: FacetCutAction.Replace,
      functionSelectors: selectors,
    },
  ]

  console.log('Replacing facet...')
  await doCut(diamondAddress, cut, initContract, initData)

  console.log('Done.')
}

async function doCut(
  diamondAddress: string,
  cut: any[],
  initContract: string,
  initData: string
): Promise<void> {
  const cutter = <IDiamondCut>(
    await ethers.getContractAt('IDiamondCut', diamondAddress)
  )

  const tx = await cutter.diamondCut(cut, initContract, initData)
  console.log('Diamond cut tx: ', tx.hash)
  const receipt = await tx.wait()
  if (!receipt.status) {
    throw Error(`Diamond upgrade failed: ${tx.hash}`)
  }
}
