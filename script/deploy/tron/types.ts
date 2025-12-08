export interface ITronDeploymentConfig {
  fullHost: string
  privateKey: string
  feeLimit?: number
  userFeePercentage?: number
  originEnergyLimit?: number
  safetyMargin?: number
  maxRetries?: number
  confirmationTimeout?: number
  verbose?: boolean
  dryRun?: boolean
}

export interface ITronCostEstimate {
  energy: number
  bandwidth: number
  totalTrx: number
  feeLimit: number
  breakdown: {
    energyCost: number
    bandwidthCost: number
    energyFactor: number
    safetyMargin: number
  }
}

export interface ITronDeploymentResult {
  contractAddress: string
  transactionId: string
  deploymentTransaction: any
  receipt: any
  costEstimate: ITronCostEstimate
  actualCost: {
    energyUsed: number
    bandwidthUsed: number
    trxCost: number
  }
}

export interface IForgeArtifact {
  abi: any[]
  bytecode: {
    object: string
    sourceMap: string
    linkReferences: Record<string, any>
  }
  deployedBytecode: {
    object: string
    sourceMap: string
    linkReferences: Record<string, any>
  }
  methodIdentifiers: Record<string, string>
  rawMetadata: string
  metadata: {
    compiler: {
      version: string
    }
    language: string
    output: any
    settings: any
    sources: Record<string, any>
    version: number
  }
}

export interface IDeploymentResult {
  contract: string
  address: string
  txId: string
  cost: number
  version: string
  status?: 'success' | 'failed' | 'existing'
}

export interface IFacetCut {
  facetAddress: string
  action: number // 0 = Add, 1 = Replace, 2 = Remove
  functionSelectors: string[]
}

export interface INetworkInfo {
  network: string
  block: number
  address: string
  balance: number
}

export interface IConstructorConfig {
  facetName: string
  args: any[]
}

export interface IDiamondRegistrationResult {
  success: boolean
  transactionId?: string
  error?: string
}
