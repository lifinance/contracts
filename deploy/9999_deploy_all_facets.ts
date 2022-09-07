import { DeployFunction } from 'hardhat-deploy/types'

const func: DeployFunction = async function () {
  console.log('All facets deployed!')
}
export default func
func.id = 'deploy_all_facets'
func.tags = ['DeployAllFacets']
func.dependencies = [
  'DeployNXTPFacet',
  'DeployHopFacet',
  'DeployAnyswapFacet',
  'DeployHyphenFacet',
  'DeployCBridgeFacet',
  'DeployGenericSwapFacet',
  'DeployAcrossFacet',
  'DeployGenericSwapFacet',
  'DeployStargateFacet',
  'DeployGnosisBridgeFacet',
  'DeployOmniBridgeFacet',
  'DeployPolygonBridgeFacet',
  'DeployArbitrumBridgeFacet',
  'DeployOptimismBridgeFacet',
  'DeployXChainExecFacet',
  'DeployWithdrawFacet',
  'DeployPeripheryRegistryFacet',
  'DeployAccessManagerFacet',
  'DeployOmniBridgeFacet',
  'DeployAmarokFacet',
]
