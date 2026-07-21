/**
 * Pure helpers and the HTTP client for TronScan contract verification.
 * Kept separate from the CLI (`../verify-tron-contracts.ts`) so the source
 * resolution and response parsing can be unit-tested without invoking the
 * command. TronScan exposes no official verification API, so this replays the
 * multipart request its web verify form submits.
 */
import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { fetchWithTimeout } from '../../../utils/fetchWithTimeout'

/** Verification recompiles a large flattened file server-side — allow 120s. */
export const VERIFY_TIMEOUT_MS = 120_000

/**
 * TronScan success markers. The endpoint returns more than one success shape —
 * status `2001` ("The contract has been validated.") and a separate code whose
 * message is "Verification success." — so we treat a success *message* as
 * authoritative rather than relying on a single status code.
 */
export const TRONSCAN_SUCCESS_MESSAGE_RE =
  /validated|verification success|already/i

/** Subdirectories searched under a flattened-sources or `src/` root. */
const CONTRACT_SUBDIRS = ['', 'Facets', 'Periphery', 'Security', 'Helpers']

export interface IVerifyParams {
  explorerApiUrl: string
  contractName: string
  address: string
  source: string
  fileName: string
  compiler: string
  optimizerRuns: number
  viaIR: boolean
  license: number
  constructorParams: string
}

export interface IVerifyResult {
  ok: boolean
  message: string
}

/**
 * Locate the flattened `<Contract>.sol` under the flattened-sources root.
 * The tree mirrors `src/`, so we search the known subdirectories plus the root
 * for an exact filename match.
 * @returns the first matching path, or `undefined` if none exists.
 */
export function resolveFlattenedPath(
  flattenedDir: string,
  contractName: string
): string | undefined {
  return CONTRACT_SUBDIRS.map((sub) =>
    sub
      ? `${flattenedDir}/${sub}/${contractName}.sol`
      : `${flattenedDir}/${contractName}.sol`
  ).find((p) => existsSync(p))
}

/**
 * Locate `<Contract>.sol` under a checkout's `src/` tree.
 * @returns the first matching path, or `undefined` if none exists.
 */
export function resolveSourcePath(
  repoRoot: string,
  contractName: string
): string | undefined {
  return CONTRACT_SUBDIRS.map((sub) =>
    sub
      ? `${repoRoot}/src/${sub}/${contractName}.sol`
      : `${repoRoot}/src/${contractName}.sol`
  ).find((p) => existsSync(p))
}

/**
 * Flatten a contract's source with `forge flatten` into a throwaway temp file,
 * return its content, and delete the temp file. Runs `forge` with the checkout
 * as cwd so import remappings resolve against that project.
 * @throws if the source cannot be located or `forge flatten` fails.
 */
export async function flattenContractSource(
  repoRoot: string,
  contractName: string
): Promise<string> {
  const srcPath = resolveSourcePath(repoRoot, contractName)
  if (!srcPath)
    throw new Error(`no source for ${contractName} under ${repoRoot}/src`)

  const outDir = mkdtempSync(join(tmpdir(), 'tron-flatten-'))
  const outFile = join(outDir, `${contractName}.sol`)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('forge', ['flatten', srcPath, '-o', outFile], {
        cwd: repoRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`forge flatten failed (exit ${code}): ${stderr}`))
      )
    })
    return readFileSync(outFile, 'utf8')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

/** Normalize constructor args to TronScan's expected form (hex without `0x`). */
export function normalizeConstructorParams(raw: string | undefined): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.toLowerCase() === '0x') return ''
  return trimmed.startsWith('0x') || trimmed.startsWith('0X')
    ? trimmed.slice(2)
    : trimmed
}

/**
 * Interpret the TronScan verification response. Success is signalled by a
 * success *message* (see {@link TRONSCAN_SUCCESS_MESSAGE_RE}); a mismatch
 * returns "...verification failed...". Falls back to the raw body if it is not
 * the expected JSON shape.
 * @returns `{ ok, message }` where message is the human-readable server reason.
 */
export function interpretResponse(
  httpOk: boolean,
  body: string
): IVerifyResult {
  let message = body.slice(0, 200)
  try {
    const json = JSON.parse(body) as { data?: { message?: string } }
    if (json.data?.message) message = json.data.message.trim()
  } catch {
    // Non-JSON body — match against the raw text below.
  }
  return { ok: httpOk && TRONSCAN_SUCCESS_MESSAGE_RE.test(message), message }
}

/**
 * Submit a single contract to the TronScan verification endpoint and interpret
 * the result.
 * @throws if the request errors or times out (caller handles).
 */
export async function verifyContractOnTronscan(
  params: IVerifyParams
): Promise<IVerifyResult> {
  const form = new FormData()
  form.append('contractAddress', params.address)
  form.append('contractName', params.contractName)
  form.append('license', String(params.license))
  form.append('compiler', params.compiler)
  form.append('optimizer', '1')
  form.append('runs', String(params.optimizerRuns))
  form.append('constructorParams', params.constructorParams)
  form.append('viaIR', params.viaIR ? '1' : '0')
  form.append(
    'files',
    new Blob([params.source], { type: 'application/octet-stream' }),
    params.fileName
  )

  const response = await fetchWithTimeout(
    `${params.explorerApiUrl}/solidity/contract/verify`,
    { method: 'POST', body: form },
    VERIFY_TIMEOUT_MS
  )
  return interpretResponse(response.ok, await response.text())
}
