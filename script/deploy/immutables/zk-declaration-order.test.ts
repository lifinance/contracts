/**
 * zkEVM addresses an immutable by ordinal, and nothing in the artifact records
 * which ordinal belongs to which name — gate L derives it from the order the
 * contract declares them in. A constructor that assigns them in a different
 * order is the shape that would make that derivation wrong, so the set of
 * contracts doing it is pinned here rather than discovered at a signing screen.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

const sourceOf = (contract: string): string | undefined => {
  for (const dir of ['src/Facets', 'src/Periphery', 'src/Security']) {
    const path = join(REPO_ROOT, dir, `${contract}.sol`)
    if (existsSync(path)) return readFileSync(path, 'utf8')
  }
  return undefined
}

const declarationOrder = (source: string): string[] =>
  [...source.matchAll(/\bimmutable\s+(\w+)\s*;/gu)].map((m) => m[1] as string)

const assignmentOrder = (source: string, declared: string[]): string[] => {
  const body = /constructor\s*\([^)]*\)[^{]*\{(.*?)\n {4}\}/su.exec(source)
  if (!body) return []
  const seen: string[] = []
  for (const m of (body[1] as string).matchAll(/^\s*(\w+)\s*=/gmu)) {
    const name = m[1] as string
    if (declared.includes(name) && !seen.includes(name)) seen.push(name)
  }
  return seen
}

/**
 * Contracts whose constructor assigns immutables out of declaration order.
 *
 * An entry is not a bug on EVM, where immutables are inlined and addressed by
 * AST id. It matters only on zkEVM, and only if zksolc numbers slots by
 * assignment rather than declaration — which is why gate L asks a human to
 * confirm the mapping instead of trusting it.
 */
const ASSIGNS_OUT_OF_ORDER: ReadonlySet<string> = new Set(['TokenWrapper'])

const contractsWithImmutables = (): string[] => {
  const registry = JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'script/deploy/resources/immutableRegistry.json'),
      'utf8'
    )
  ) as Record<string, unknown>
  return Object.keys(registry).sort()
}

describe('zkEVM immutable declaration order', () => {
  const offenders = contractsWithImmutables().filter((contract) => {
    const source = sourceOf(contract)
    if (!source) return false
    const declared = declarationOrder(source)
    const assigned = assignmentOrder(source, declared)
    const shared = declared.filter((one) => assigned.includes(one))
    return (
      shared.length > 0 &&
      shared.join(',') !==
        assigned.filter((one) => shared.includes(one)).join(',')
    )
  })

  it('finds no contract assigning out of declaration order that is not already known', () => {
    expect(offenders.filter((one) => !ASSIGNS_OUT_OF_ORDER.has(one))).toEqual(
      []
    )
  })

  it('still finds every contract the known set names, so a fixed one is removed from it', () => {
    for (const known of ASSIGNS_OUT_OF_ORDER) expect(offenders).toContain(known)
  })
})
