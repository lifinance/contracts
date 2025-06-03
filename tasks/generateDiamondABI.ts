import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import type { Fragment } from '@ethersproject/abi'
import { defineCommand, runMain } from 'citty'

const basePath = 'src/Facets/'
const libraryBasePath = 'src/Libraries/'

const main = defineCommand({
  meta: {
    name: 'generate-diamond-abi',
    description:
      'Generates ABI file for diamond, includes all ABIs of facets and libraries',
  },

  async run() {
    const scriptPath = path.dirname(fileURLToPath(import.meta.url))

    // Create an empty array to store the ABI fragments
    const abi: Fragment[] = []

    // Get a list of all the files in the Facets directory
    let files = fs.readdirSync(scriptPath + '/../' + basePath)

    // Read the compiled ABI of each facet and add it to the abi array
    for (const file of files) {
      const jsonFile = file.replace('sol', 'json')
      const data = fs.readFileSync(
        path.resolve(scriptPath, `../out/${file}/${jsonFile}`)
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = JSON.parse(data.toString())
      abi.push(...json.abi)
    }

    // Get a list of all the files in the Libraries directory
    files = fs.readdirSync(scriptPath + '/../' + libraryBasePath)

    // Read the compiled ABI of each library and add it to the abi array
    for (const file of files) {
      const jsonFile = file.replace('sol', 'json')
      const data = fs.readFileSync(
        path.resolve(scriptPath, `../out/${file}/${jsonFile}`)
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = JSON.parse(data.toString())
      abi.push(...json.abi)
    }

    // Remove duplicates from the combined ABI object
    // Filters by checking if the name and type of the
    // function already exists in another ABI fragment
    const cleanAbi = <Fragment[]>(
      abi
        .filter(
          (item, index, self) =>
            index ===
            self.findIndex((t) => t.name === item.name && t.type === item.type)
        )
        .filter((item) => item.type !== 'constructor')
    )

    // Write the final ABI to a file
    const finalAbi = JSON.stringify(cleanAbi)
    fs.writeFileSync('./diamond.json', finalAbi)
    console.log('ABI written to diamond.json')
  },
})

runMain(main)
