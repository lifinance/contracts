/**
 * Tests for the printable-field primitive.
 *
 * Every assertion runs the real function against the value a hostile row would
 * hold. The bounds are pinned by value, not through their own symbols: an
 * assertion written as `text.length).toBe(MAX_FIELD_CHARS)` moves with the
 * constant, so a quorum-style drop from 120 to 1 — or a rise to 500,000 —
 * would keep the suite green.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  asPrintable,
  color,
  colorAroundNotices,
  concatPrintable,
  fieldNotice,
  MAX_FIELD_CHARS,
  MAX_PARKED_REFS,
  printableField,
  trustedMarkup,
  UNBOUNDED,
} from './printable-field'

const ESC = String.fromCharCode(27)
/** Cyrillic small letter O — drawn identically to the ASCII one. */
const CYRILLIC_O = '\u043e'
/** Kept by `sanitizeProvenanceText` by design, and invisible. */
const ZWJ = '\u200d'
const HANGUL_FILLER = '\u3164'

describe('asPrintable', () => {
  it('leaves a benign ASCII value untouched and says nothing', () => {
    const hash =
      '0x7c6d5e4f3a2b1908172635445362718091a2b3c4d5e6f708192a3b4c5d6e7f80' // pre-commit-checker: not a secret
    const field = asPrintable(hash)
    expect(field.text as string).toBe(hash)
    expect(field.notice).toBe('')
    expect(field.identityPreserved).toBe(true)
  })

  it('strips a screen-clearing sequence and reports both lengths', () => {
    const field = asPrintable(`${ESC}[2J${ESC}[Hfake`)
    expect(field.text as string).toBe('[2J[Hfake')
    expect(field.text as string).not.toContain(ESC)
    expect(field.notice).toBe(
      '\u001b[33m ⚠ sanitised for display — stored 11, printable 9\u001b[0m'
    )
    expect(field.identityPreserved).toBe(false)
  })

  it('clips a field that needs no escape at all to flood the terminal', () => {
    const field = asPrintable(`0x${'a'.repeat(500_000)}`)
    // 120 written out: the bound is the claim, so the constant cannot be the
    // thing that decides whether the claim holds.
    expect(field.text.length).toBe(120)
    expect(MAX_FIELD_CHARS).toBe(120)
    expect(field.notice).toBe(
      '\u001b[33m ⚠ clipped for display — stored 500002, shown 120\u001b[0m'
    )
    expect(field.identityPreserved).toBe(false)
  })

  it('leaves the calldata whole, being the payload under signature', () => {
    const calldata = `0x${'ab'.repeat(20_000)}`
    expect(asPrintable(calldata, UNBOUNDED).text as string).toBe(calldata)
    expect(asPrintable(calldata, UNBOUNDED).notice).toBe('')
  })

  it('counts the invisibles the sanitiser keeps by design', () => {
    const field = asPrintable(`Acr${ZWJ}oss${HANGUL_FILLER}FacetV3`)
    expect(field.notice).toBe(
      '\u001b[33m ⚠ 2 invisible characters among 15 printable\u001b[0m'
    )
    expect(field.identityPreserved).toBe(false)
  })

  it('discloses a homoglyph that renders identically to ASCII', () => {
    const field = asPrintable(`Acr${CYRILLIC_O}ssFacetV3`)
    expect(field.text as string).toBe(`Acr${CYRILLIC_O}ssFacetV3`)
    expect(field.notice).toBe(
      '\u001b[33m ⚠ 1 non-ASCII character — a letter here can be drawn identically to an ASCII one\u001b[0m'
    )
    expect(field.identityPreserved).toBe(false)
  })

  it('counts an invisible once, not twice under two descriptions', () => {
    const field = asPrintable(`facet${ZWJ}`)
    expect(field.notice).toContain('1 invisible character')
    expect(field.notice).not.toContain('non-ASCII')
  })

  it('reports a value it cannot even coerce', () => {
    const field = asPrintable({
      toString: () => {
        throw new Error('no')
      },
    })
    expect(field.text as string).toBe('unrenderable')
    expect(field.identityPreserved).toBe(false)
  })

  it('keeps an absent field visibly absent rather than blank', () => {
    expect(asPrintable(undefined).text as string).toBe('undefined')
    expect(asPrintable(null).text as string).toBe('null')
  })

  it('names a container that was never a string', () => {
    expect(asPrintable(['a']).notice).toContain('stored as an array')
    expect(asPrintable({ a: 1 }).notice).toContain('stored as an object')
  })

  it('clips by code point, so no lone surrogate is emitted', () => {
    // 121 astral characters: a clip by UTF-16 index would cut the 120th pair.
    const field = asPrintable('😀'.repeat(121))
    expect([...field.text].length).toBe(120)
    expect(field.text.endsWith('😀')).toBe(true)
  })

  it('counts an invisible sitting past the clip, and says it clipped', () => {
    // The two remarks answer different questions and a clipped field needs
    // both: an invisible beyond the boundary is never shown, but it is still
    // covered by the signature, so counting only the visible prefix would
    // under-report what is being signed.
    const field = asPrintable(`${'a'.repeat(200)}‍`)

    expect([...field.text].length).toBe(120)
    expect(field.text).not.toContain('‍')
    expect(field.notice).toContain('1 invisible character')
    expect(field.notice).toContain('clipped for display')
    // Paired present: an unclipped value with no invisible earns neither remark.
    expect(asPrintable('a'.repeat(10)).notice).toBe('')
  })
})

describe('printableField', () => {
  it('is the text with the notice after it', () => {
    expect(printableField('0xdeadbeef') as string).toBe('0xdeadbeef')
    expect(printableField(`${ESC}[31mred`) as string).toBe(
      '[31mred\u001b[33m ⚠ sanitised for display — stored 8, printable 7\u001b[0m'
    )
  })
})

describe('the printable brand', () => {
  it('composes without losing it', () => {
    expect(color('\u001b[32m', trustedMarkup('ok')) as string).toBe(
      '\u001b[32mok\u001b[0m'
    )
    expect(
      concatPrintable(trustedMarkup('a'), trustedMarkup('b')) as string
    ).toBe('ab')
  })
})

describe('MAX_PARKED_REFS', () => {
  it('is 20 — pinned by value, since it is the bound being claimed', () => {
    expect(MAX_PARKED_REFS).toBe(20)
  })
})

describe('colorAroundNotices', () => {
  it('re-opens the colour a notice closed, so the rest is not uncoloured', () => {
    // The failure it exists to prevent: a plain wrapper leaves everything
    // after the first notice colourless, which reads as a rendering glitch
    // rather than as the warning it follows.
    const value = `cut=A${fieldNotice('clipped for display')} then=B`
    const line = colorAroundNotices('34', value)

    expect(line).toBe(
      `${ESC}[34mcut=A${ESC}[33m \u26a0 clipped for display${ESC}[0m${ESC}[34m then=B${ESC}[0m`
    )
    // Every reset in the line is followed by either the colour re-opening or
    // the end of the line — nothing is left unpainted mid-value.
    for (const part of line.split(`${ESC}[0m`).slice(1))
      expect(part === '' || part.startsWith(`${ESC}[34m`)).toBe(true)
  })

  it('leaves a value carrying no notice exactly as a plain wrapper would', () => {
    expect(colorAroundNotices('32', 'plain')).toBe(`${ESC}[32mplain${ESC}[0m`)
  })

  it('cannot be asked for the notice colour', () => {
    // Structural, not asserted at runtime: yellow is the notice's own colour,
    // so painting a value in it would make the two indistinguishable. The line
    // below must not compile.
    // @ts-expect-error -- '33' is outside ValueColor
    expect(() => colorAroundNotices('33', 'x')).toBeDefined()
  })
})
