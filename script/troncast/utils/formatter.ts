import type { ITransactionReceipt } from '../types'

export function formatReceipt(receipt: ITransactionReceipt): string {
  const lines = [
    `Transaction ID: ${receipt.id}`,
    `Block Number: ${receipt.blockNumber}`,
    `Energy Used: ${receipt.energy_usage}`,
    `Energy Total: ${receipt.energy_usage_total}`,
    `Bandwidth Used: ${receipt.net_usage}`,
    `Status: ${receipt.result || 'SUCCESS'}`,
  ]

  if (receipt.resMessage) lines.push(`Message: ${receipt.resMessage}`)

  return lines.join('\n')
}

export function formatError(error: any): string {
  if (error.message) return `Error: ${error.message}`

  return `Error: ${String(error)}`
}

export function formatGasUsage(usage: {
  energy: number
  bandwidth: number
  cost: number
}): string {
  return [
    `Energy: ${usage.energy}`,
    `Bandwidth: ${usage.bandwidth}`,
    `Estimated Cost: ${usage.cost} TRX`,
  ].join('\n')
}

export function formatValue(value: string | number, decimals = 6): string {
  const num = typeof value === 'string' ? parseFloat(value) : value
  const trx = num / Math.pow(10, decimals)
  return `${trx} TRX`
}
