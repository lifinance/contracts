import { afterEach, describe, expect, it, spyOn } from 'bun:test'

import { ed25519 } from '@noble/curves/ed25519.js'

import { computeSolanaATABytes32, deriveSolanaAddress } from './solanaAddress'

// Vectors generated with the Solana web3.js 1.98 and spl-token 0.4 SDKs before they were removed.
const KEY_11 = `0x${'11'.repeat(32)}`
const OWNER_11 = 'F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4'
const OWNER_07 = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ATA_OWNER_11_USDC =
  '0xb85e0cbc52560b10d2aa80e4d5e2f699dae197d350bd06a677797bd76d528ee8'
// Bump 251, so the PDA search has to skip four on-curve candidates.
const ATA_OWNER_07_USDC =
  '0x67302e491894d7492ea6be4f914ea4f45fa142e645867c9164a276d5dd76f076'
// The ATA of OWNER_11 for USDC, a PDA and therefore off the ed25519 curve.
const OFF_CURVE_OWNER = 'DQhCHAxmJxGcys4CvR2PCb9bkaCHTRHDAMJz73u98jwm'

async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp
): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(String(error)).toMatch(match)
    return
  }
  throw new Error(`expected rejection matching ${match}`)
}

describe('deriveSolanaAddress', () => {
  it('derives the ed25519 public key from the first 32 bytes of the key', () => {
    expect(deriveSolanaAddress(KEY_11)).toBe(OWNER_11)
  })

  it('accepts a key without 0x prefix', () => {
    expect(deriveSolanaAddress('07'.repeat(32))).toBe(OWNER_07)
  })
})

describe('computeSolanaATABytes32', () => {
  it('computes the USDC ATA of an owner', async () => {
    expect(await computeSolanaATABytes32(OWNER_11, USDC_MINT)).toBe(
      ATA_OWNER_11_USDC
    )
  })

  it('finds the ATA when the bump is below 255', async () => {
    expect(await computeSolanaATABytes32(OWNER_07, USDC_MINT)).toBe(
      ATA_OWNER_07_USDC
    )
  })

  describe('when every bump candidate is on the curve', () => {
    let fromHexSpy: ReturnType<typeof spyOn> | undefined

    afterEach(() => {
      fromHexSpy?.mockRestore()
    })

    it('rejects once all bumps are exhausted', async () => {
      fromHexSpy = spyOn(ed25519.Point, 'fromHex').mockImplementation(
        () => ed25519.Point.BASE
      )
      await expectRejects(
        computeSolanaATABytes32(OWNER_11, USDC_MINT),
        /Unable to find a viable program address bump seed/
      )
      expect(fromHexSpy).toHaveBeenCalledTimes(256)
    })
  })

  it('rejects an owner that is not base58', async () => {
    await expectRejects(
      computeSolanaATABytes32('0OIl', USDC_MINT),
      /Invalid Solana owner address 0OIl: not base58/
    )
  })

  it('rejects a mint that is not base58', async () => {
    await expectRejects(
      computeSolanaATABytes32(OWNER_11, 'not-base58!'),
      /Invalid Solana mint address not-base58!: not base58/
    )
  })

  it('rejects an owner that does not decode to 32 bytes', async () => {
    await expectRejects(
      computeSolanaATABytes32('11111111', USDC_MINT),
      /Invalid Solana owner address 11111111: 8 bytes \(expected 32\)/
    )
  })

  it('rejects a mint that does not decode to 32 bytes', async () => {
    await expectRejects(
      computeSolanaATABytes32(OWNER_11, `${USDC_MINT}1`),
      /Invalid Solana mint address .*: 33 bytes \(expected 32\)/
    )
  })

  it('rejects an owner off the ed25519 curve', async () => {
    await expectRejects(
      computeSolanaATABytes32(OFF_CURVE_OWNER, USDC_MINT),
      /is off the ed25519 curve/
    )
  })
})
