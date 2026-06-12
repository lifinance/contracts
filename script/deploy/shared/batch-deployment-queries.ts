/**
 * Batch execution of deployment-log lookups against MongoDB (or the local cache).
 * Used by the `batch` subcommand of `script/deploy/query-deployment-logs.ts` so shell
 * callers can answer many (contract, network, version | address) lookups in a single
 * process invocation with one or few MongoDB round-trips.
 */

import { EnvironmentEnum } from '../../common/types'

import type { IDeploymentRecord } from './mongo-log-utils'

/** Supported lookup operations; each mirrors an existing single-query CLI command. */
export type BatchQueryOp = 'get' | 'latest' | 'find' | 'exists' | 'history'

/** A single lookup inside a batch request. */
export interface IBatchQueryRequest {
  /** Caller-chosen identifier echoed back in the result (defaults to the array index). */
  id?: string
  op: BatchQueryOp
  /** Per-query environment override; falls back to the batch-level default. */
  env?: keyof typeof EnvironmentEnum
  contract?: string
  network?: string
  version?: string
  address?: string
}

/** Result for a single lookup inside a batch request. */
export interface IBatchQueryResult {
  id: string
  op: BatchQueryOp
  found: boolean
  /** Single record for get/latest/find, record array for history, null otherwise. */
  data: IDeploymentRecord | IDeploymentRecord[] | null
  error?: string
}

/**
 * Minimal querier surface needed to execute a batch.
 * Both `CachedDeploymentQuerier` and `DeploymentLogQuerier` satisfy it structurally.
 */
export interface IBatchQuerier {
  getLatestDeployment: (
    contractName: string,
    network: string
  ) => Promise<IDeploymentRecord | null>
  findByAddress: (
    address: string,
    network: string
  ) => Promise<IDeploymentRecord | null>
  filterDeployments: (filters: {
    contractName?: string
    network?: string
    version?: string
    verified?: boolean
    limit?: number
  }) => Promise<IDeploymentRecord[]>
  getDeploymentHistory: (
    contractName: string,
    network: string
  ) => Promise<IDeploymentRecord[]>
}

const VALID_OPS: readonly BatchQueryOp[] = [
  'get',
  'latest',
  'find',
  'exists',
  'history',
]

function isValidOp(value: unknown): value is BatchQueryOp {
  return typeof value === 'string' && VALID_OPS.includes(value as BatchQueryOp)
}

function isValidEnv(value: unknown): value is keyof typeof EnvironmentEnum {
  return (
    typeof value === 'string' &&
    Object.values<string>(EnvironmentEnum).includes(value)
  )
}

/**
 * Parses and validates a JSON batch-query payload.
 * @param json - JSON string containing an array of query objects
 * @returns Validated batch query requests
 * @throws {Error} When the payload is not a non-empty array of valid query objects
 */
export function parseBatchQueries(json: string): IBatchQueryRequest[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Batch queries payload is not valid JSON')
  }

  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error('Batch queries payload must be a non-empty JSON array')

  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null)
      throw new Error(`Query at index ${index} is not an object`)

    const query = entry as Record<string, unknown>
    if (!isValidOp(query.op))
      throw new Error(
        `Query at index ${index} has invalid op '${String(
          query.op
        )}' (expected one of: ${VALID_OPS.join(', ')})`
      )

    if (query.env !== undefined && !isValidEnv(query.env))
      throw new Error(
        `Query at index ${index} has invalid env '${String(
          query.env
        )}' (expected staging or production)`
      )

    const stringField = (name: string): string | undefined => {
      const value = query[name]
      if (value === undefined) return undefined
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (trimmed === '')
        throw new Error(
          `Query at index ${index} has invalid '${name}' (expected non-empty string)`
        )
      // Return the trimmed value: whitespace-padded fields would pass
      // validation but never match the stored contract/network names
      return trimmed
    }

    const request: IBatchQueryRequest = {
      id: stringField('id') ?? String(index),
      op: query.op,
      env: query.env as keyof typeof EnvironmentEnum | undefined,
      contract: stringField('contract'),
      network: stringField('network'),
      version: stringField('version'),
      address: stringField('address'),
    }

    validateRequiredFields(request, index)
    return request
  })
}

type RequiredQueryField = 'contract' | 'network' | 'version' | 'address'

const REQUIRED_FIELDS_BY_OP: Record<BatchQueryOp, RequiredQueryField[]> = {
  get: ['contract', 'network', 'version'],
  exists: ['contract', 'network', 'version'],
  latest: ['contract', 'network'],
  history: ['contract', 'network'],
  find: ['address', 'network'],
}

function validateRequiredFields(
  request: IBatchQueryRequest,
  index: number
): void {
  for (const field of REQUIRED_FIELDS_BY_OP[request.op])
    if (!request[field])
      throw new Error(
        `Query at index ${index} (op '${request.op}') is missing required field '${field}'`
      )
}

async function executeSingleQuery(
  request: IBatchQueryRequest,
  querier: IBatchQuerier
): Promise<IBatchQueryResult> {
  const base = { id: request.id ?? '', op: request.op }
  try {
    switch (request.op) {
      case 'get':
      case 'exists': {
        const records = await querier.filterDeployments({
          contractName: request.contract,
          network: request.network,
          version: request.version,
          limit: 1,
        })
        const record = records[0] ?? null
        return {
          ...base,
          found: record !== null,
          data: request.op === 'exists' ? null : record,
        }
      }
      case 'latest': {
        const record = await querier.getLatestDeployment(
          request.contract as string,
          request.network as string
        )
        return { ...base, found: record !== null, data: record }
      }
      case 'find': {
        const record = await querier.findByAddress(
          request.address as string,
          request.network as string
        )
        return { ...base, found: record !== null, data: record }
      }
      case 'history': {
        const records = await querier.getDeploymentHistory(
          request.contract as string,
          request.network as string
        )
        return { ...base, found: records.length > 0, data: records }
      }
      // unreachable: parseBatchQueries rejects unsupported ops, but lint requires it
      default:
        return {
          ...base,
          found: false,
          data: null,
          error: `Unsupported op '${String(request.op)}'`,
        }
    }
  } catch (error) {
    return {
      ...base,
      found: false,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Executes a batch of deployment-log lookups, reusing one querier per environment.
 * @param requests - Validated batch query requests (see {@link parseBatchQueries})
 * @param defaultEnv - Environment applied to queries without a per-query env override
 * @param getQuerier - Factory resolving the querier for an environment; called at most
 *   once per distinct environment in the batch so connections/cache loads are shared
 * @returns One result per request, in request order
 */
export async function executeBatchQueries(
  requests: IBatchQueryRequest[],
  defaultEnv: keyof typeof EnvironmentEnum,
  getQuerier: (
    env: keyof typeof EnvironmentEnum
  ) => Promise<IBatchQuerier> | IBatchQuerier
): Promise<IBatchQueryResult[]> {
  const queriers = new Map<keyof typeof EnvironmentEnum, IBatchQuerier>()
  const querierErrors = new Map<keyof typeof EnvironmentEnum, string>()

  // Resolve queriers sequentially first so each environment is initialized exactly once,
  // then run all lookups in parallel against the shared querier instances.
  // An environment that fails to initialize must not reject the whole batch:
  // its queries are reported as per-query error results so requests against
  // other environments still return data (mixed staging/production callers).
  const environments = [...new Set(requests.map((r) => r.env ?? defaultEnv))]
  for (const env of environments)
    try {
      queriers.set(env, await getQuerier(env))
    } catch (error) {
      querierErrors.set(
        env,
        error instanceof Error ? error.message : String(error)
      )
    }

  return Promise.all(
    requests.map(async (request) => {
      const env = request.env ?? defaultEnv
      const querier = queriers.get(env)
      if (!querier)
        return {
          id: request.id ?? '',
          op: request.op,
          found: false,
          data: null,
          error: `Failed to initialize querier for environment '${env}': ${
            querierErrors.get(env) ?? 'unknown error'
          }`,
        }
      return executeSingleQuery(request, querier)
    })
  )
}
