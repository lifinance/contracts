/**
 * Derives Solana addresses (wallet address and associated token account) without a Solana SDK.
 * Import from demo scripts that bridge to Solana and need the signer's Solana address or its ATA.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'
import { concatBytes, sha256, toHex } from 'viem'

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ASSOCIATED_TOKEN_PROGRAM_ID =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress')

/**
 * Derives a Solana address from an Ethereum private key.
 * Uses the first 32 bytes of the EVM private key as seed for Ed25519 keypair generation.
 * @param ethPrivateKey - Ethereum private key (with or without 0x prefix)
 * @returns Solana address in base58 format
 */
export const deriveSolanaAddress = (ethPrivateKey: string): string => {
  const seed = ethPrivateKey.replace('0x', '')

  const seedBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    seedBytes[i] = parseInt(seed.slice(i * 2, i * 2 + 2), 16)
  }

  return bs58.encode(ed25519.getPublicKey(seedBytes))
}

/**
 * Computes the Associated Token Account (ATA) for a Solana address and token mint, returns bytes32 hex.
 * Used when bridging to Solana (e.g. Polymer CCTP) where CCTP v2 requires mintRecipient to be the ATA.
 * @param solanaAddress - Solana wallet address in base58 format
 * @param tokenMint - Token mint address in base58 format (e.g. USDC on Solana)
 * @returns ATA address as bytes32 hex string
 * @throws If either address is not a 32-byte base58 key, or the owner is off the ed25519 curve
 */
export async function computeSolanaATABytes32(
  solanaAddress: string,
  tokenMint: string
): Promise<`0x${string}`> {
  const owner = decodePublicKey(solanaAddress, 'owner')
  const mint = decodePublicKey(tokenMint, 'mint')
  if (!isOnCurve(owner)) {
    throw new Error(
      `Solana owner ${solanaAddress} is off the ed25519 curve (e.g. a PDA); it cannot own an ATA`
    )
  }

  const ata = findProgramAddress(
    [owner, bs58.decode(TOKEN_PROGRAM_ID), mint],
    bs58.decode(ASSOCIATED_TOKEN_PROGRAM_ID)
  )
  return toHex(ata)
}

function decodePublicKey(address: string, label: string): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = bs58.decode(address)
  } catch (error) {
    throw new Error(
      `Invalid Solana ${label} address ${address}: not base58 (${String(error)})`
    )
  }
  if (bytes.length !== 32) {
    throw new Error(
      `Invalid Solana ${label} address ${address}: ${bytes.length} bytes (expected 32)`
    )
  }
  return bytes
}

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromHex(bytes)
    return true
  } catch {
    return false
  }
}

// Mirrors Solana web3.js findProgramAddressSync: bumps 255 down to 1, first off-curve hash wins.
function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array
): Uint8Array {
  for (let bump = 255; bump > 0; bump--) {
    const address = sha256(
      concatBytes([...seeds, Uint8Array.of(bump), programId, PDA_MARKER]),
      'bytes'
    )
    if (!isOnCurve(address)) return address
  }
  throw new Error('Unable to find a viable program address bump seed')
}
