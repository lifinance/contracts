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
 * Complete TronScan success messages, each matched against the whole message.
 *
 * These three are the only success wordings anyone here has observed. The
 * endpoint is undocumented, so all three come from the reverse-engineering in
 * PR #2095: a live submission returned status `2001` ("The contract has been
 * validated.") and a separate code whose message is "Verification success.",
 * and re-submitting an already-verified contract returned the third. A success
 * *message* is authoritative rather than a status code because of the first
 * two.
 *
 * An allowlist of whole messages rather than a substring search: a match is
 * persisted to the deployment record as `verified: true`, and a substring turns
 * a negated or in-progress message — "not already verified", "already in the
 * verification queue" — into a durable claim that the contract is verified.
 *
 * Failing closed is what makes that safe, because it is recoverable: an
 * unrecognised wording is reported as a failure with the wording printed and
 * nothing is written, the contract is verified on TronScan either way, and a
 * re-run answers "already verified" — which this list accepts. So a wording we
 * have not seen costs one re-run after it is added here, while a wrong accept
 * is a durable false record.
 */
export const TRONSCAN_SUCCESS_MESSAGES: readonly RegExp[] = [
  /^the contract has been validated\.?$/i,
  /^verification success\.?$/i,
  /^(the contract has )?already (been )?verified\.?$/i,
]

/**
 * Whether TronScan's response message reports a verified contract.
 * @param message - Server message, as returned or as raw body text
 */
export function isTronscanSuccessMessage(message: string): boolean {
  const trimmed = message.trim()
  return TRONSCAN_SUCCESS_MESSAGES.some((pattern) => pattern.test(trimmed))
}

/** Subdirectories searched under a flattened-sources or `src/` root. */
const CONTRACT_SUBDIRS = ['', 'Facets', 'Periphery', 'Security', 'Helpers']

export interface IVerifyParams {
  readonly explorerApiUrl: string
  readonly contractName: string
  readonly address: string
  readonly source: string
  readonly fileName: string
  readonly compiler: string
  readonly optimizerRuns: number
  readonly viaIR: boolean
  readonly license: number
}

export interface IVerifyResult {
  readonly ok: boolean
  readonly message: string
}

/**
 * Reject a value that is interpolated into a filesystem path unless it is a
 * bare, separator-free segment. Network keys and contract names are the only
 * caller-supplied values that reach `deployments/<network>.json` or the
 * flattened/source paths, so validating them here closes the path-traversal
 * surface (`..`, `/`, absolute paths) at the point of use.
 * @throws if `value` contains anything outside `[A-Za-z0-9_-]`.
 */
export function assertSafePathSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(
      `unsafe ${label} "${value}": expected characters in [A-Za-z0-9_-]`
    )
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

/**
 * Interpret the TronScan verification response. Success is signalled by a
 * success *message* (see {@link isTronscanSuccessMessage}); a mismatch returns
 * "...verification failed...". Falls back to the raw body if it is not the
 * expected JSON shape — which is not one of the accepted messages, so an
 * unparseable response reads as a failure and is printed for the operator.
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
  return { ok: httpOk && isTronscanSuccessMessage(message), message }
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
  // TronScan matches runtime bytecode, so constructor args are never needed, but
  // the verify form always sends this field — keep it (empty) to mirror the
  // confirmed-working request shape rather than dropping it from the multipart body.
  form.append('constructorParams', '')
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
