/**
 * Read-side helpers for the per-network deploy logs (`deployments/<network>.json`).
 * Shared by the deploy-time reminder CLIs; deliberately forgiving — a missing or
 * malformed log yields an empty map, never an exception, because these reads run
 * best-effort inside deploy pipelines that must not break on log state.
 */
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

import { DEPLOYMENT_FILE_SUFFIX } from './constants'

/**
 * Network keys in `config/networks.json` are alphanumeric with optional `-`/`_` (e.g. `bsc-testnet`).
 * Reject anything else so a caller-supplied name can never traverse outside `deployments/`
 * (e.g. `../../.env`) once composed into a file path.
 */
export function isValidNetworkName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name)
}

/**
 * Read a network's deploy log. Returns an empty map when the name is not a plain network key, or
 * when the file is missing or unreadable — a brand-new network legitimately has no log yet, and
 * the reminder must never break a deploy.
 */
export function readDeployLog(
  network: string,
  environment: string,
  repoRoot: string
): Record<string, string> {
  if (!isValidNetworkName(network)) return {}

  const deploymentsDir = resolve(repoRoot, 'deployments')
  const path = resolve(
    deploymentsDir,
    `${network}.${DEPLOYMENT_FILE_SUFFIX(environment)}json`
  )
  // Belt-and-braces on top of the name check: the resolved path must stay inside deployments/,
  // so no combination of inputs can make this read an arbitrary file.
  const relativeToDir = relative(deploymentsDir, path)
  if (relativeToDir.startsWith('..') || isAbsolute(relativeToDir)) return {}

  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string' && value.length > 0)
        .map(([name, value]) => [name, value as string])
    )
  } catch {
    return {}
  }
}
