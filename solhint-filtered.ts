import * as fs from 'fs'
import { execSync } from 'child_process'
import * as path from 'path'

// load stored versions from contracts.json
const contractVersions = {
  'src/LiFiDiamond.sol': '1.0.0',
  'src/Facets/CalldataVerificationFacet.sol': '1.2.0',
  'src/Facets/StargateFacet.sol': '2.2.0',
  'src/Facets/HopFacet.sol': '2.0.0',
  'src/Facets/EmergencyPauseFacet.sol': '1.0.1',
  'src/Facets/HopFacetPacked.sol': '1.0.6',
  'src/Facets/GasZipFacet.sol': '2.0.2',
  'src/Facets/OmniBridgeFacet.sol': '1.0.0',
  'src/Facets/AllBridgeFacet.sol': '2.0.0',
  'src/Facets/AmarokFacetPacked.sol': '1.0.0',
  'src/Facets/PolygonBridgeFacet.sol': '1.0.0',
  'src/Facets/AcrossFacet.sol': '2.0.0',
  'src/Facets/SquidFacet.sol': '1.0.0',
  'src/Facets/DeBridgeDlnFacet.sol': '1.0.0',
  'src/Facets/CBridgeFacet.sol': '1.0.0',
  'src/Facets/AcrossFacetV3.sol': '1.1.0',
  'src/Facets/StargateFacetV2.sol': '1.0.1',
  'src/Facets/ThorSwapFacet.sol': '1.2.1',
  'src/Facets/MayanFacet.sol': '1.0.0',
  'src/Facets/CelerIMFacetMutable.sol': '2.0.0',
  'src/Facets/CelerCircleBridgeFacet.sol': '1.0.1',
  'src/Facets/AcrossFacetPacked.sol': '1.0.0',
  'src/Facets/ArbitrumBridgeFacet.sol': '1.0.0',
  'src/Facets/CBridgeFacetPacked.sol': '1.0.3',
  'src/Facets/RelayFacet.sol': '1.0.0',
  'src/Facets/AcrossFacetPackedV3.sol': '1.2.0',
  'src/Facets/AmarokFacet.sol': '3.0.0',
  'src/Facets/GnosisBridgeFacet.sol': '1.0.0',
  'src/Facets/GenericSwapFacetV3.sol': '1.0.1',
  'src/Facets/SymbiosisFacet.sol': '1.0.0',
  'src/Libraries/LibUtil.sol': '1.0.0',
  'src/Libraries/LibAsset.sol': '1.0.2',
  'src/Libraries/LibBytes.sol': '1.0.0',
  'src/Periphery/ReceiverStargateV2.sol': '1.1.0',
  'src/Periphery/TokenWrapper.sol': '1.1.0',
  'src/Periphery/RelayerCelerIM.sol': '2.1.1',
  'src/Periphery/Receiver.sol': '2.1.0',
  'src/Periphery/Permit2Proxy.sol': '1.0.2',
  'src/Periphery/LiFiDEXAggregator.sol': '1.6.0',
  'src/Periphery/GasZipPeriphery.sol': '1.0.1',
  'src/Periphery/ReceiverAcrossV3.sol': '1.1.0',
  'src/Helpers/CelerIMFacetBase.sol': '1.0.0',
  'src/Helpers/Validatable.sol': '1.0.0',
  'src/Interfaces/IStargateRouter.sol': '1.0.0',
  'src/Security/LiFiTimelockController.sol': '1.0.0',
}

// get staged .sol files from lint-staged
const files: string[] = process.argv.slice(2)
const filesToLint: string[] = []

files.forEach((file) => {
  // convert absolute path to relative path (relative to your contracts directory)
  const relativeFile = path.relative(process.cwd(), file)

  if (fs.existsSync(file) && file.endsWith('.sol')) {
    const content = fs.readFileSync(file, 'utf8')

    // extract @custom:version from the file
    const versionMatch = content.match(/@custom:version\s+([\d.]+)/)
    const currentVersion = versionMatch ? versionMatch[1] : null

    // compare with stored version using the relative path
    const storedVersion = contractVersions[relativeFile] || null

    if (!currentVersion) {
      console.log(
        `⚠️  ${relativeFile} has no @custom:version. Including for linting.`
      )
      filesToLint.push(file)
    } else if (
      !storedVersion ||
      isVersionNewer(currentVersion, storedVersion)
    ) {
      console.log(
        `✅ ${relativeFile} has a newer version (${currentVersion}). Linting.`
      )
      filesToLint.push(file)
    } else {
      console.log(
        `⏭️  ${relativeFile} is unchanged (version ${currentVersion}). Skipping.`
      )
    }
  }
})

// run Solhint only on relevant files
if (filesToLint.length > 0) {
  try {
    console.log(`Running Solhint on: ${filesToLint.join(', ')}`)
    execSync(`npx solhint --noPrompt --fix ${filesToLint.join(' ')}`, {
      stdio: 'inherit',
    })
  } catch (error: any) {
    // in case of deeper solhint error you print just error.message if needed:
    // console.error(error.message)
    process.exit(error.status || 1)
  }
} else {
  console.log('No Solidity files need linting.')
}

// function to compare versions
function isVersionNewer(current: string, stored: string): boolean {
  const parseVersion = (v: string) => v.split('.').map(Number)
  const [cMajor, cMinor, cPatch] = parseVersion(current)
  const [sMajor, sMinor, sPatch] = parseVersion(stored)

  return (
    cMajor > sMajor ||
    (cMajor === sMajor && cMinor > sMinor) ||
    (cMajor === sMajor && cMinor === sMinor && cPatch > sPatch)
  )
}
