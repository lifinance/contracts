/**
 * Whether `bun lint:js` (oxlint with `.oxlintrc.json`) enforces the naming
 * convention through the local `lifi` plugin, and whether the
 * `eslint-disable` directives already in `script/` and `tasks/` still switch
 * off the oxlint rule that replaced the one they name.
 *
 * Every case is a file in a scratch directory, linted by the real oxlint CLI
 * in one type-aware run with the repo config, so the plugin is loaded the way
 * `bun lint:js` and lint-staged load it.
 */

import { execFileSync } from 'child_process'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const OXLINT = join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')
const CONFIG = join(REPO_ROOT, '.oxlintrc.json')
const NAMING = 'lifi(naming-convention)'

/** 3 minutes: one cold type-aware oxlint run over a handful of files. */
const TIMEOUT_MS = 180_000

interface IDiagnostic {
  code: string
  filename: string
  message: string
}

const COMPLIANT = [
  'export interface INetwork { id: number }',
  'export interface IERC20Like { symbol: string }',
  'export type SupportedChain = string',
  'export type Address2 = string',
  'export enum EnvironmentEnum { staging, production }',
  // An empty remainder after the affix passes, as it did under typescript-eslint
  'export interface I { id: number }',
  'export enum Enum { staging }',
].join('\n')

const REFUSED: Array<[string, string]> = [
  [
    'an interface without the I prefix',
    'export interface Network { id: number }',
  ],
  [
    'an interface whose I starts a word',
    'export interface Inventory { n: number }',
  ],
  [
    'an interface with an underscore',
    'export interface INet_work { id: number }',
  ],
  ['a camelCase type alias', 'export type supportedChain = string'],
  ['a type alias with an underscore', 'export type Supported_Chain = string'],
  ['an enum without the Enum suffix', 'export enum Environment { staging }'],
  ['a camelCase enum', 'export enum environmentEnum { staging }'],
  [
    'an enum with an underscore before the suffix',
    'export enum Environment_Enum { staging }',
  ],
]

/**
 * One case per rule named by an `eslint-disable` directive in `script/` or
 * `tasks/`: the code that rule refuses, placed right after `directive`, and
 * the oxlint diagnostic code that replaced the ESLint rule.
 */
const DIRECTIVE_CASES: Record<
  string,
  { code: string; source: (directive: string) => string }
> = {
  '@typescript-eslint/no-explicit-any': {
    code: 'typescript(no-explicit-any)',
    source: (d) => `${d}\nexport const value: any = 1\n`,
  },
  '@typescript-eslint/naming-convention': {
    code: NAMING,
    source: (d) => `${d}\nexport interface Network { id: number }\n`,
  },
  '@typescript-eslint/no-namespace': {
    code: 'typescript(no-namespace)',
    source: (d) => `${d}\nexport namespace Space { export const a = 1 }\n`,
  },
  '@typescript-eslint/await-thenable': {
    code: 'typescript(await-thenable)',
    source: (d) =>
      `export async function f(): Promise<number> {\n  ${d}\n  return await 1\n}\n`,
  },
  'no-template-curly-in-string': {
    code: 'eslint(no-template-curly-in-string)',
    source: (d) => `${d}\nexport const template = '\${name}'\n`,
  },
  'no-throw-literal': {
    code: 'eslint(no-throw-literal)',
    source: (d) => `export function f(): void {\n  ${d}\n  throw 'boom'\n}\n`,
  },
  'no-control-regex': {
    code: 'eslint(no-control-regex)',
    source: (d) => `${d}\nexport const pattern = /\\x1b/\n`,
  },
  'import/first': {
    code: 'import(first)',
    source: (d) =>
      `export const a = 1\n${d}\nimport { join } from 'path'\nexport const b = join\n`,
  },
  'import/no-default-export': {
    code: 'import(no-default-export)',
    source: (d) => `${d}\nexport default 1\n`,
  },
  'no-var': {
    code: 'eslint(no-var)',
    source: (d) => `${d}\nvar legacy = 1\nexport { legacy }\n`,
  },
}

const NON_COMPLIANT = 'export interface Network { id: number }'
const LEGACY = '@typescript-eslint/naming-convention'

/**
 * How the naming rule reads a directive that names the ESLint rule it
 * replaces, and whether it still reports.
 */
const LEGACY_DIRECTIVES: Array<[string, string, number]> = [
  [
    'a trailing eslint-disable-line suppresses',
    `${NON_COMPLIANT} // eslint-disable-line ${LEGACY}`,
    0,
  ],
  [
    'a rule list naming it suppresses',
    `// eslint-disable-next-line no-var, ${LEGACY}\n${NON_COMPLIANT}`,
    0,
  ],
  [
    'a directive with a -- reason suppresses',
    `// eslint-disable-next-line ${LEGACY} -- matches a Solidity struct\n${NON_COMPLIANT}`,
    0,
  ],
  [
    'a directive naming another rule still reports',
    `// eslint-disable-next-line no-var\n${NON_COMPLIANT}`,
    1,
  ],
  [
    'a next-line directive two lines up still reports',
    `// eslint-disable-next-line ${LEGACY}\nexport const a = 1\n${NON_COMPLIANT}`,
    1,
  ],
]

/** Rules the repo switches off for a whole file with a block directive. */
const BLOCK_FORM = ['no-template-curly-in-string', 'import/first']

/**
 * Rules named by a directive that `bun lint:js` does not run, so there is
 * nothing for the directive to switch off there.
 */
const NOT_IN_OXLINT: Record<string, string> = {
  'import/no-unresolved':
    'dropped; bare imports are checked by script/utils/validateScripts.ts',
  'import/order': 'dropped; oxlint has no import/order rule',
  'no-restricted-syntax':
    'the ESLint fences own it, and they run with --no-inline-config',
}

// The hook below runs oxlint; the pinned bun types take no per-hook timeout
setDefaultTimeout(TIMEOUT_MS)

// Real path, because oxlint reports the resolved path of a file outside the repo
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'oxlint-plugin-lifi-')))
const files = new Map<string, string>()
let diagnostics: IDiagnostic[] = []

const addCase = (name: string, source: string): void => {
  const path = join(workDir, `${name}.ts`)
  writeFileSync(path, source)
  files.set(name, path)
}

const findings = (name: string, code: string): IDiagnostic[] =>
  diagnostics.filter(
    (d) => d.code === code && resolve(REPO_ROOT, d.filename) === files.get(name)
  )

beforeAll(() => {
  writeFileSync(
    join(workDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, module: 'ESNext', target: 'es2022' },
      include: ['*.ts'],
    })
  )
  addCase('compliant', `${COMPLIANT}\n`)
  REFUSED.forEach(([, source], i) => addCase(`refused${i}`, `${source}\n`))
  LEGACY_DIRECTIVES.forEach(([, source], i) =>
    addCase(`legacy${i}`, `${source}\n`)
  )
  for (const [rule, { source }] of Object.entries(DIRECTIVE_CASES)) {
    const slug = rule.replace(/\W/g, '_')
    addCase(`bare_${slug}`, source('// no directive'))
    addCase(`next_line_${slug}`, source(`// eslint-disable-next-line ${rule}`))
    addCase(
      `block_${slug}`,
      `/* eslint-disable ${rule} */\n${source('// no directive')}`
    )
  }

  let stdout: string
  try {
    stdout = execFileSync(
      OXLINT,
      ['--type-aware', '-c', CONFIG, '-f', 'json', ...files.values()],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: TIMEOUT_MS }
    )
  } catch (error) {
    // oxlint exits 1 when it reports an error; the JSON is still on stdout
    const { stdout: failedStdout, stderr } = error as {
      stdout?: string
      stderr?: string
    }
    if (!failedStdout?.trim().startsWith('{'))
      throw new Error(`oxlint produced no report:\n${stderr ?? error}`)
    stdout = failedStdout
  }
  diagnostics = (JSON.parse(stdout) as { diagnostics: IDiagnostic[] })
    .diagnostics
})

afterAll(() => rmSync(workDir, { recursive: true, force: true }))

describe('lifi/naming-convention', () => {
  it('accepts names that follow every convention', () => {
    expect(findings('compliant', NAMING)).toEqual([])
  })

  it.each(REFUSED.map(([label], i) => [label, i] as const))(
    'refuses %s',
    (_label, i) => {
      expect(findings(`refused${i}`, NAMING)).toHaveLength(1)
    }
  )

  it('names the declaration and the expected shape', () => {
    const [finding] = findings('refused0', NAMING)
    expect(finding?.message).toContain('`Network`')
    expect(finding?.message).toContain('`I` prefix')
  })
})

describe('lifi/naming-convention and directives naming the ESLint rule', () => {
  it.each(
    LEGACY_DIRECTIVES.map(([label, , count], i) => [label, count, i] as const)
  )('%s', (_label, count, i) => {
    expect(findings(`legacy${i}`, NAMING)).toHaveLength(count)
  })
})

describe('existing eslint-disable directives', () => {
  it.each(
    Object.entries(DIRECTIVE_CASES).map(([rule, { code }]) => [rule, code])
  )('`%s` still switches off %s', (rule, code) => {
    const slug = rule.replace(/\W/g, '_')
    expect(findings(`bare_${slug}`, code)).toHaveLength(1)
    expect(findings(`next_line_${slug}`, code)).toEqual([])
  })

  it.each(BLOCK_FORM)(
    'a file-level `%s` block directive still applies',
    (rule) => {
      const { code } = DIRECTIVE_CASES[rule] ?? { code: '' }
      expect(code).not.toBe('')
      expect(findings(`block_${rule.replace(/\W/g, '_')}`, code)).toEqual([])
    }
  )

  it('covers every rule a directive in script/ or tasks/ names', () => {
    const tracked = execFileSync('git', ['ls-files', 'script', 'tasks'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((path) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(path))
      // Its directives are the fixtures above
      .filter((path) => path !== 'script/utils/oxlint-plugin-lifi.test.ts')

    const named = new Set<string>()
    for (const path of tracked) {
      const text = readFileSync(join(REPO_ROOT, path), 'utf8')
      for (const [, list] of text.matchAll(
        /eslint-disable(?:-next-line|-line)?[ \t]+([^\n*'"`]+)/g
      ))
        for (const rule of (list ?? '').split('--')[0]?.split(',') ?? [])
          if (rule.trim()) named.add(rule.trim())
    }

    const uncovered = [...named].filter(
      (rule) => !(rule in DIRECTIVE_CASES) && !(rule in NOT_IN_OXLINT)
    )
    expect(uncovered).toEqual([])
  })
})
