import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { consola } from 'consola'

import type {
  EnvironmentName,
  ITrackingActionEntry,
  ITrackingState,
} from './types'

export interface IActionMeta {
  id: string
  label: string
  paramsHash: string
}

const createRunId = (): string =>
  `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`

const createActionEntry = (): ITrackingActionEntry => ({
  status: 'pending',
  attempts: 0,
  lastAttempt: null,
  error: null,
})

const buildActionKey = (actionId: string, paramsHash: string): string =>
  `${actionId}:${paramsHash}`

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(',')}]`

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b)
    )
    const body = entries
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
      .join(',')
    return `{${body}}`
  }

  return JSON.stringify(value)
}

export const hashActionParams = (params: Record<string, unknown>): string => {
  const hash = createHash('sha256')
  hash.update(stableStringify(params))
  return hash.digest('hex')
}

const safeParseJson = (contents: string): ITrackingState | null => {
  try {
    return JSON.parse(contents) as ITrackingState
  } catch (error) {
    consola.warn(`Failed to parse tracking file: ${(error as Error).message}`)
    return null
  }
}

const createNewState = (
  environment: EnvironmentName,
  actions: IActionMeta[]
): ITrackingState => ({
  runId: createRunId(),
  environment,
  createdAt: new Date().toISOString(),
  actions,
  networks: {},
})

const ensureNetworkEntries = (
  state: ITrackingState,
  networkId: string,
  actionKeys: string[]
) => {
  if (!state.networks[networkId]) state.networks[networkId] = { actions: {} }
  const networkActions = state.networks[networkId]?.actions
  if (!networkActions) return

  for (const key of actionKeys) {
    if (!networkActions[key]) networkActions[key] = createActionEntry()
  }
}

const updateStateForRun = (
  state: ITrackingState,
  actions: IActionMeta[],
  networks: string[]
): ITrackingState => {
  const actionKeys = actions.map((action) =>
    buildActionKey(action.id, action.paramsHash)
  )

  state.actions = actions

  for (const networkId of networks) {
    ensureNetworkEntries(state, networkId, actionKeys)
  }

  return state
}

export class TrackingStore {
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly actionKeys: string[]

  public constructor(
    private readonly path: string,
    private readonly state: ITrackingState,
    actions: IActionMeta[]
  ) {
    this.actionKeys = actions.map((action) =>
      buildActionKey(action.id, action.paramsHash)
    )
  }

  public getActionKey(actionId: string, paramsHash: string): string {
    return buildActionKey(actionId, paramsHash)
  }

  public getEntry(networkId: string, actionKey: string): ITrackingActionEntry {
    const entry = this.state.networks[networkId]?.actions?.[actionKey]
    if (!entry)
      throw new Error(`Tracking entry missing for ${networkId} (${actionKey})`)
    return entry
  }

  public shouldSkip(networkId: string, actionKey: string): boolean {
    const entry = this.state.networks[networkId]?.actions?.[actionKey]
    return entry?.status === 'success'
  }

  public startAction(networkId: string, actionKey: string): void {
    const entry = this.getEntry(networkId, actionKey)
    entry.status = 'in_progress'
    entry.attempts += 1
    entry.lastAttempt = new Date().toISOString()
    entry.error = null
  }

  public finishAction(
    networkId: string,
    actionKey: string,
    status: ITrackingActionEntry['status'],
    error?: string
  ): void {
    const entry = this.getEntry(networkId, actionKey)
    entry.status = status
    entry.error = error ?? null
  }

  public async save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const tmpPath = join(
        tmpdir(),
        `multi-network-${Date.now()}-${Math.random()}.json`
      )
      writeFileSync(tmpPath, JSON.stringify(this.state, null, 2))
      renameSync(tmpPath, this.path)
    })

    await this.writeQueue
  }

  public getSnapshot(): ITrackingState {
    return this.state
  }

  public getTrackedNetworks(): string[] {
    return Object.keys(this.state.networks)
  }

  public getActionKeys(): string[] {
    return [...this.actionKeys]
  }
}

export const loadTrackingStore = (options: {
  path: string
  environment: EnvironmentName
  actions: IActionMeta[]
  networks: string[]
}): TrackingStore => {
  const { path, environment, actions, networks } = options

  let state: ITrackingState | null = null
  if (existsSync(path)) {
    const contents = readFileSync(path, 'utf8')
    state = safeParseJson(contents)
    if (state && state.environment !== environment) {
      consola.warn(
        `Tracking file environment mismatch (${state.environment}); resetting for ${environment}`
      )
      state = null
    }
  }

  if (!state) state = createNewState(environment, actions)

  const updated = updateStateForRun(state, actions, networks)
  return new TrackingStore(path, updated, actions)
}
