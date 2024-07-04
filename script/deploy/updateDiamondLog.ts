import { defineCommand, runMain } from 'citty'
import fs from 'fs'
import { isProduction } from '../../deploy/9999_utils'

export interface DiamondFile {
  [diamond: string]: {
    Facets: {
      [contract: string]: {
        Name: string
        Version: string
      }
    }
    Periphery: { [contract: string]: string }
  }
}

const main = defineCommand({
  meta: {
    name: 'updateDiamondLog',
    description: 'Add entry to diamond log file',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name',
      required: true,
    },
    name: {
      type: 'string',
      description: 'Contract name',
      required: true,
    },
    address: {
      type: 'string',
      description: 'Contract address',
      required: true,
    },
    version: {
      type: 'string',
      description: 'Contract version',
      required: true,
    },
    periphery: {
      type: 'boolean',
      description: 'Is periphery contract',
      default: false,
    },
    isProduction: {
      type: 'boolean',
      description: 'Is production network',
      default: true,
    },
  },
  async run({ args }) {
    const { network, name, address, periphery, version } = args
    updateDiamond(name, network, address, isProduction, {
      isPeriphery: periphery,
      version: version,
    })
  },
})

const updateDiamond = function (
  name: string,
  network: string,
  address: string,
  isProduction: boolean,
  options: {
    isPeriphery?: boolean
    version?: string
  }
) {
  let data: DiamondFile = {}

  const diamondContractName = 'LiFiDiamond'

  const diamondFile = isProduction
    ? `deployments/${network}.diamond.json`
    : `deployments/${network}.diamond.staging.json`

  try {
    data = JSON.parse(fs.readFileSync(diamondFile, 'utf8')) as DiamondFile
  } catch {}

  if (!data[diamondContractName]) {
    data[diamondContractName] = {
      Facets: {},
      Periphery: {},
    }
  }

  if (options.isPeriphery) {
    data[diamondContractName].Periphery[name] = address
  } else {
    // Check if entry with name already exists
    // If so, replace it
    data[diamondContractName].Facets = Object.fromEntries(
      Object.entries(data[diamondContractName].Facets).map(([key, value]) => {
        if (value.Name === name) {
          return [address, { Name: name, Version: options.version || '' }]
        }
        return [key, value]
      })
    )
    // If not, add new entry
    data[diamondContractName].Facets[address] = {
      Name: name,
      Version: options.version || '',
    }
  }

  fs.writeFileSync(diamondFile, JSON.stringify(data, null, 2))
}

runMain(main)
