import type { IExecutionGroup, INetworkConfig } from './types'

interface IGroupingResult {
  groups: IExecutionGroup[]
  skipped: INetworkConfig[]
}

const normalizeEvmVersion = (value?: string): string =>
  value?.toLowerCase() ?? ''

export const groupNetworks = (
  networks: INetworkConfig[],
  defaultEvmVersion: string
): IGroupingResult => {
  const normalizedDefault = normalizeEvmVersion(defaultEvmVersion)
  const londonVersion = 'london'

  const zkevm = networks.filter((network) => network.isZkEVM)
  const nonZk = networks.filter((network) => !network.isZkEVM)

  const primary = nonZk.filter(
    (network) =>
      normalizeEvmVersion(network.deployedWithEvmVersion) === normalizedDefault
  )

  const london =
    normalizedDefault === londonVersion
      ? []
      : nonZk.filter(
          (network) =>
            normalizeEvmVersion(network.deployedWithEvmVersion) ===
            londonVersion
        )

  const groupedIds = new Set([
    ...primary.map((network) => network.id),
    ...london.map((network) => network.id),
    ...zkevm.map((network) => network.id),
  ])

  const skipped = networks.filter((network) => !groupedIds.has(network.id))

  const groups: IExecutionGroup[] = []
  if (primary.length > 0)
    groups.push({
      name: 'primary',
      evmVersion: normalizedDefault,
      networks: primary,
    })
  if (london.length > 0)
    groups.push({ name: 'london', evmVersion: londonVersion, networks: london })
  if (zkevm.length > 0) groups.push({ name: 'zkevm', networks: zkevm })

  return { groups, skipped }
}
