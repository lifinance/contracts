import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved, import/order
} from 'bun:test'

import {
  type BatchQueryOp,
  type IBatchQuerier,
  type IBatchQueryRequest,
  executeBatchQueries,
  parseBatchQueries,
} from './batch-deployment-queries'
import type { IDeploymentRecord } from './mongo-log-utils'

function makeRecord(
  overrides: Partial<IDeploymentRecord> = {}
): IDeploymentRecord {
  return {
    contractName: 'Executor',
    network: 'mainnet',
    version: '2.0.0',
    address: '0x1111111111111111111111111111111111111111',
    optimizerRuns: '200',
    timestamp: new Date('2025-01-01T00:00:00Z'),
    constructorArgs: '0xdeadbeef',
    salt: '',
    verified: true,
    solcVersion: '0.8.29',
    evmVersion: 'cancun',
    zkSolcVersion: '',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    contractNetworkKey: 'Executor-mainnet',
    contractVersionKey: 'Executor-2.0.0',
    ...overrides,
  }
}

interface IQuerierCallLog {
  getLatestDeployment: [string, string][]
  findByAddress: [string, string][]
  filterDeployments: object[]
  getDeploymentHistory: [string, string][]
}

function makeQuerier(
  records: IDeploymentRecord[],
  callLog?: IQuerierCallLog
): IBatchQuerier {
  return {
    async getLatestDeployment(contractName, network) {
      callLog?.getLatestDeployment.push([contractName, network])
      return (
        records.find(
          (r) => r.contractName === contractName && r.network === network
        ) ?? null
      )
    },
    async findByAddress(address, network) {
      callLog?.findByAddress.push([address, network])
      return (
        records.find(
          (r) =>
            r.address.toLowerCase() === address.toLowerCase() &&
            r.network === network
        ) ?? null
      )
    },
    async filterDeployments(filters) {
      callLog?.filterDeployments.push(filters)
      let filtered = records
      if (filters.contractName)
        filtered = filtered.filter(
          (r) => r.contractName === filters.contractName
        )
      if (filters.network)
        filtered = filtered.filter((r) => r.network === filters.network)
      if (filters.version)
        filtered = filtered.filter((r) => r.version === filters.version)
      if (filters.verified !== undefined)
        filtered = filtered.filter((r) => r.verified === filters.verified)
      if (filters.limit) filtered = filtered.slice(0, filters.limit)
      return filtered
    },
    async getDeploymentHistory(contractName, network) {
      callLog?.getDeploymentHistory.push([contractName, network])
      return records.filter(
        (r) => r.contractName === contractName && r.network === network
      )
    },
  }
}

describe('parseBatchQueries', () => {
  it('parses a valid batch and applies defaults', () => {
    const queries = parseBatchQueries(
      JSON.stringify([
        {
          op: 'get',
          contract: 'Executor',
          network: 'mainnet',
          version: '2.0.0',
        },
        {
          id: 'custom',
          op: 'find',
          env: 'staging',
          address: '0x1111111111111111111111111111111111111111',
          network: 'mainnet',
        },
      ])
    )

    expect(queries).toHaveLength(2)
    expect(queries[0]?.id).toBe('0')
    expect(queries[0]?.env).toBeUndefined()
    expect(queries[1]?.id).toBe('custom')
    expect(queries[1]?.env).toBe('staging')
  })

  it('rejects invalid JSON', () => {
    expect(() => parseBatchQueries('not-json')).toThrow(
      'Batch queries payload is not valid JSON'
    )
  })

  it('rejects non-array and empty-array payloads', () => {
    expect(() => parseBatchQueries('{}')).toThrow(
      'Batch queries payload must be a non-empty JSON array'
    )
    expect(() => parseBatchQueries('[]')).toThrow(
      'Batch queries payload must be a non-empty JSON array'
    )
  })

  it('rejects non-object queries', () => {
    expect(() => parseBatchQueries('["x"]')).toThrow(
      'Query at index 0 is not an object'
    )
    expect(() => parseBatchQueries('[null]')).toThrow(
      'Query at index 0 is not an object'
    )
  })

  it('rejects invalid op and env values', () => {
    expect(() => parseBatchQueries('[{"op":"drop"}]')).toThrow(
      "Query at index 0 has invalid op 'drop'"
    )
    expect(() =>
      parseBatchQueries(
        '[{"op":"latest","env":"dev","contract":"Executor","network":"mainnet"}]'
      )
    ).toThrow("Query at index 0 has invalid env 'dev'")
  })

  it('rejects empty or non-string field values', () => {
    expect(() =>
      parseBatchQueries('[{"op":"latest","contract":"","network":"mainnet"}]')
    ).toThrow("Query at index 0 has invalid 'contract'")
    expect(() =>
      parseBatchQueries('[{"op":"latest","contract":1,"network":"mainnet"}]')
    ).toThrow("Query at index 0 has invalid 'contract'")
  })

  it('enforces required fields per op', () => {
    expect(() =>
      parseBatchQueries(
        '[{"op":"get","contract":"Executor","network":"mainnet"}]'
      )
    ).toThrow("missing required field 'version'")
    expect(() =>
      parseBatchQueries(
        '[{"op":"exists","network":"mainnet","version":"1.0.0"}]'
      )
    ).toThrow("missing required field 'contract'")
    expect(() =>
      parseBatchQueries('[{"op":"latest","contract":"Executor"}]')
    ).toThrow("missing required field 'network'")
    expect(() =>
      parseBatchQueries('[{"op":"history","network":"mainnet"}]')
    ).toThrow("missing required field 'contract'")
    expect(() =>
      parseBatchQueries('[{"op":"find","network":"mainnet"}]')
    ).toThrow("missing required field 'address'")
    expect(() =>
      parseBatchQueries(
        '[{"op":"find","address":"0x1111111111111111111111111111111111111111"}]'
      )
    ).toThrow("missing required field 'network'")
  })
})

describe('executeBatchQueries', () => {
  const record = makeRecord()
  const stagingRecord = makeRecord({
    contractName: 'Receiver',
    version: '1.1.0',
    address: '0x2222222222222222222222222222222222222222',
  })

  it('executes all supported ops and preserves request order', async () => {
    const querier = makeQuerier([record])
    const requests: IBatchQueryRequest[] = [
      {
        id: 'g',
        op: 'get',
        contract: 'Executor',
        network: 'mainnet',
        version: '2.0.0',
      },
      { id: 'l', op: 'latest', contract: 'Executor', network: 'mainnet' },
      { id: 'f', op: 'find', address: record.address, network: 'mainnet' },
      {
        id: 'e',
        op: 'exists',
        contract: 'Executor',
        network: 'mainnet',
        version: '2.0.0',
      },
      { id: 'h', op: 'history', contract: 'Executor', network: 'mainnet' },
    ]

    const results = await executeBatchQueries(
      requests,
      'production',
      () => querier
    )

    expect(results.map((r) => r.id)).toEqual(['g', 'l', 'f', 'e', 'h'])
    expect(results.every((r) => r.found)).toBe(true)
    expect(results[0]?.data).toEqual(record)
    expect(results[1]?.data).toEqual(record)
    expect(results[2]?.data).toEqual(record)
    // exists returns no data payload, only the found flag
    expect(results[3]?.data).toBeNull()
    expect(results[4]?.data).toEqual([record])
  })

  it('reports misses as found=false with null/empty data', async () => {
    const querier = makeQuerier([])
    const results = await executeBatchQueries(
      [
        {
          id: 'g',
          op: 'get',
          contract: 'Executor',
          network: 'mainnet',
          version: '9.9.9',
        },
        { id: 'h', op: 'history', contract: 'Executor', network: 'mainnet' },
      ],
      'production',
      () => querier
    )

    expect(results[0]).toMatchObject({ id: 'g', found: false, data: null })
    expect(results[1]).toMatchObject({ id: 'h', found: false, data: [] })
  })

  it('initializes one querier per distinct environment', async () => {
    const envCalls: string[] = []
    const results = await executeBatchQueries(
      [
        { id: 'p1', op: 'latest', contract: 'Executor', network: 'mainnet' },
        {
          id: 's1',
          op: 'latest',
          env: 'staging',
          contract: 'Receiver',
          network: 'mainnet',
        },
        { id: 'p2', op: 'latest', contract: 'Executor', network: 'mainnet' },
      ],
      'production',
      async (env) => {
        envCalls.push(env)
        return makeQuerier(env === 'staging' ? [stagingRecord] : [record])
      }
    )

    expect(envCalls).toEqual(['production', 'staging'])
    expect(results[0]?.data).toEqual(record)
    expect(results[1]?.data).toEqual(stagingRecord)
    expect(results[2]?.data).toEqual(record)
  })

  it('captures per-query errors without failing the whole batch', async () => {
    const failingQuerier: IBatchQuerier = {
      ...makeQuerier([record]),
      async getLatestDeployment() {
        throw new Error('mongo unavailable')
      },
    }

    const results = await executeBatchQueries(
      [
        { id: 'bad', op: 'latest', contract: 'Executor', network: 'mainnet' },
        { id: 'ok', op: 'find', address: record.address, network: 'mainnet' },
      ],
      'production',
      () => failingQuerier
    )

    expect(results[0]).toMatchObject({
      id: 'bad',
      found: false,
      data: null,
      error: 'mongo unavailable',
    })
    expect(results[1]).toMatchObject({ id: 'ok', found: true })
  })

  it('stringifies non-Error throwables in the error field', async () => {
    const failingQuerier: IBatchQuerier = {
      ...makeQuerier([]),
      async findByAddress() {
        // eslint-disable-next-line no-throw-literal -- exercising the non-Error path
        throw 'string failure'
      },
    }

    const results = await executeBatchQueries(
      [{ id: 'f', op: 'find', address: record.address, network: 'mainnet' }],
      'production',
      () => failingQuerier
    )

    expect(results[0]?.error).toBe('string failure')
  })

  it('reports an unsupported op that bypassed parsing as an error result', async () => {
    const results = await executeBatchQueries(
      [
        {
          id: 'x',
          op: 'bogus' as BatchQueryOp,
          contract: 'Executor',
          network: 'mainnet',
        },
      ],
      'production',
      () => makeQuerier([record])
    )

    expect(results[0]).toMatchObject({
      id: 'x',
      found: false,
      data: null,
      error: "Unsupported op 'bogus'",
    })
  })
})
