/**
 * Whether the local oxlint plugin enforces the repo's naming conventions when
 * loaded through the repo config, the way `bun lint:js` and lint-staged run it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const OXLINT = join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')
const CONFIG = join(REPO_ROOT, '.oxlintrc.json')
const RULE = 'lifi(naming-convention)'

const workDir = mkdtempSync(join(tmpdir(), 'oxlint-plugin-lifi-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

let fileCount = 0

/** Lints `source` as a standalone `.ts` file and returns the rule's findings. */
const namingFindings = (source: string): string[] => {
  fileCount += 1
  const file = join(workDir, `case${fileCount}.ts`)
  writeFileSync(file, source)

  const result = Bun.spawnSync(
    [OXLINT, '-c', CONFIG, '-A', 'all', '-D', 'lifi/naming-convention', file],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' }
  )
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0 && !output.includes(RULE))
    throw new Error(`oxlint failed without a naming finding:\n${output}`)

  return output.split('\n').filter((line) => line.includes(RULE))
}

describe('lifi/naming-convention', () => {
  it('accepts names that follow every convention', () => {
    expect(
      namingFindings(
        'export interface INetwork { id: number }\n' +
          'export interface IERC20Like { symbol: string }\n' +
          'export type SupportedChain = string\n' +
          'export enum EnvironmentEnum { staging, production }\n'
      )
    ).toEqual([])
  })

  it.each([
    [
      'an interface without the I prefix',
      'export interface Network { id: number }',
    ],
    [
      'an interface whose I starts a word',
      'export interface Inventory { id: number }',
    ],
    [
      'an interface with an underscore',
      'export interface INet_work { id: number }',
    ],
    ['a camelCase type alias', 'export type supportedChain = string'],
    ['a type alias with an underscore', 'export type Supported_Chain = string'],
    ['an enum without the Enum suffix', 'export enum Environment { staging }'],
    ['an enum named only Enum', 'export enum Enum { staging }'],
    ['a camelCase enum', 'export enum environmentEnum { staging }'],
  ])('refuses %s', (_label, source) => {
    expect(namingFindings(`${source}\n`)).toHaveLength(1)
  })

  it('names the declaration and the expected shape', () => {
    const [finding] = namingFindings(
      'export interface Network { id: number }\n'
    )
    expect(finding).toContain('`Network`')
    expect(finding).toContain('`I` prefix')
  })
})
