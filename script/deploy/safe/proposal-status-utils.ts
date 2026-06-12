/**
 * Pure helpers for summarizing Safe proposal documents from MongoDB into a
 * compact, display/JSON-friendly shape. Used by list-pending-proposals.ts;
 * import from here when another script needs the same summary shape.
 */

import type { ISafeTxDocument } from './safe-utils'

export interface IProposalSummary {
  network: string
  chainId: number
  safeAddress: string
  nonce: number
  to: string
  selector: string
  status: string
  signatureCount: number
  signers: string[]
  proposer: string
  safeTxHash: string
  timestamp: string
  executionHash?: string
}

/**
 * Counts signatures on a Safe tx document. In MongoDB `safeTx.signatures` is
 * a plain object keyed by lowercased signer address (the in-memory Map is
 * serialized on insert); absent or empty means no signatures yet.
 * @param doc - Safe tx document from MongoDB
 * @returns Lowercased signer addresses found on the document
 */
export function getSigners(doc: ISafeTxDocument): string[] {
  const signatures = doc.safeTx?.signatures
  if (!signatures) return []
  const entries =
    signatures instanceof Map
      ? Array.from(signatures.values())
      : Object.values(signatures)
  const signers: string[] = []
  for (const entry of entries)
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'signer' in entry &&
      typeof (entry as { signer: unknown }).signer === 'string'
    )
      signers.push((entry as { signer: string }).signer.toLowerCase())

  return signers
}

/**
 * Extracts the 4-byte function selector from Safe tx calldata.
 * @param data - Calldata hex string from the Safe tx document
 * @returns `0x`-prefixed selector, or `0x` when no calldata is present
 */
export function getSelector(data: unknown): string {
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10)
    return '0x'
  return data.substring(0, 10)
}

/**
 * Converts a MongoDB Safe tx document into a flat summary row.
 * @param doc - Safe tx document from MongoDB
 * @returns Summary with signature count, selector, and normalized fields
 */
export function summarizeProposalDoc(doc: ISafeTxDocument): IProposalSummary {
  const signers = getSigners(doc)
  const timestamp =
    doc.timestamp instanceof Date
      ? doc.timestamp.toISOString()
      : String(doc.timestamp ?? '')

  const summary: IProposalSummary = {
    network: doc.network,
    chainId: doc.chainId,
    safeAddress: doc.safeAddress,
    nonce: Number(doc.safeTx?.data?.nonce ?? 0),
    to: String(doc.safeTx?.data?.to ?? ''),
    selector: getSelector(doc.safeTx?.data?.data),
    status: doc.status,
    signatureCount: signers.length,
    signers,
    proposer: doc.proposer,
    safeTxHash: doc.safeTxHash,
    timestamp,
  }
  if (doc.executionHash) summary.executionHash = doc.executionHash
  return summary
}
