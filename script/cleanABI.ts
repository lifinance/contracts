import fs from 'fs-extra'

interface Event {
  type: string
  name: string
  inputs: any[]
  anonymous: boolean
}

async function cleanABI() {
  // Files that we know have duplicate events
  const filesToClean = [
    'out/OwnershipFacet.sol/OwnershipFacet.json',
    'out/DiamondCutFacet.sol/DiamondCutFacet.json',
  ]

  for (const file of filesToClean) {
    if (!fs.existsSync(file)) {
      console.log(`File ${file} not found, skipping...`)
      continue
    }

    const content = await fs.readJson(file)
    const abi = content.abi as any[]

    // Track seen events to remove duplicates
    const seenEvents = new Map<string, Event>()
    const cleanedABI = abi.filter((item) => {
      if (item.type === 'event') {
        const key = `${item.name}_${JSON.stringify(item.inputs)}`
        if (seenEvents.has(key)) {
          return false
        }
        seenEvents.set(key, item)
      }
      return true
    })

    // Update the ABI in the file
    content.abi = cleanedABI
    await fs.writeJson(file, content, { spaces: 2 })
    console.log(`Cleaned duplicate events from ${file}`)
  }
}

cleanABI().catch(console.error)
