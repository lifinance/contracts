export interface IFunctionSignature {
  name: string
  inputs: IParameter[]
  outputs: IParameter[]
  stateMutability?: 'pure' | 'view' | 'nonpayable' | 'payable'
}

export interface IParameter {
  name?: string
  type: string
  components?: IParameter[] // For tuples/structs
}

export interface ITransactionOptions {
  from?: string
  value?: string | number
  feeLimit?: string | number
  energyLimit?: number
}

export interface ICallOptions {
  block?: number | string
  from?: string
}

export interface ITransactionReceipt {
  id: string
  blockNumber: number
  energy_usage: number
  energy_usage_total: number
  net_usage: number
  result?: string
  resMessage?: string
}

export type Environment = 'mainnet' | 'staging'
