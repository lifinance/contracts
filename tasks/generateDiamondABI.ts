import fs from 'fs'
import path from 'path'
import { Fragment } from '@ethersproject/abi'
import { task } from 'hardhat/config'
import { Interface } from 'ethers/lib/utils'

const basePath = 'src/Facets/'
const libraryBasePath = 'src/Libraries/'

task(
  'diamondABI',
  'Generates ABI file for diamond, includes all ABIs of facets'
).setAction(async () => {
  // Create an empty array to store the ABI fragments
  const abi: Fragment[] = []

  // Get a list of all the files in the Facets directory
  let files = fs.readdirSync(__dirname + '/../' + basePath)

  // Read the compiled ABI of each facet and add it to the abi array
  for (const file of files) {
    const jsonFile = file.replace('sol', 'json')
    const data = fs.readFileSync(
      path.resolve(__dirname, `../out/${file}/${jsonFile}`)
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = JSON.parse(data.toString())
    abi.push(...json.abi)
  }

  // Get a list of all the files in the Libraries directory
  files = fs.readdirSync(__dirname + '/../' + libraryBasePath)

  // Read the compiled ABI of each library and add it to the abi array
  for (const file of files) {
    const jsonFile = file.replace('sol', 'json')
    const data = fs.readFileSync(
      path.resolve(__dirname, `../out/${file}/${jsonFile}`)
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = JSON.parse(data.toString())
    abi.push(...json.abi)
  }

  // Remove duplicates from the combined ABI object
  // Filters by checking if the name and type of the
  // function already exists in another ABI fragment
  const cleanAbi = <Fragment[]>(
    abi.filter(
      (item, index, self) =>
        index ===
        self.findIndex((t) => t.name === item.name && t.type === item.type)
    )
  )

  // Write the final ABI to a file
  const finalAbi = JSON.stringify(cleanAbi)
  fs.writeFileSync('./diamond.json', finalAbi)

  // try to parse it
  const extractedABI = extractAbi(finalAbi)
  console.log(`ABI extracted`)
  // console.log(`ABI extracted : ${extractedABI}`)

  if (validateAbi(JSON.parse(finalAbi)))
    throw Error('ABI validation step failed')
  console.log('ABI written to diamond.json')
})

function extractAbi(rawJson: any) {
  let json = rawJson

  if (typeof rawJson === 'string') {
    try {
      json = JSON.parse(rawJson)
    } catch (error) {
      throw new Error(`Not a json: (error: ${error})`)
    }
  }

  if (!json) {
    throw new Error('Not a json 2')
  }

  if (Array.isArray(json)) {
    return json
  }

  if (Array.isArray(json.abi)) {
    return json.abi
  } else if (json.compilerOutput && Array.isArray(json.compilerOutput.abi)) {
    return json.compilerOutput.abi
  }

  throw new Error('Not a valid ABI')
}

// Function to validate ABI
function validateAbi(abi: any): boolean {
  console.log('validating ABI now')
  try {
    // Ensure the ABI is an array
    if (!Array.isArray(abi)) {
      throw new Error('ABI is not an array')
    }

    // Create an Interface instance to validate the ABI
    const iface = new Interface(abi)

    // Iterate through each fragment to ensure they are valid
    abi.forEach((fragment: any) => {
      if (fragment.type === 'constructor' || fragment.type === 'receive') {
        // Constructor and receive fragments are valid by default
        // console.log(`Special fragment found: ${JSON.stringify(fragment)}`)
        return
      }
      try {
        iface.getFunction(fragment.name)
      } catch (error) {
        try {
          iface.getEvent(fragment.name)
        } catch (error) {
          try {
            iface.getError(fragment.name)
          } catch (error) {
            throw new Error(`Invalid fragment: ${JSON.stringify(fragment)}`)
          }
        }
      }
    })

    return true // ABI is valid
  } catch (error) {
    console.error(`ABI validation failed: ${JSON.stringify(error, null, 2)}`)
    return false // ABI is invalid
  }
}
