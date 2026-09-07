import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { defineCommand, runCommand } from 'citty'

import {
  findMultiWordArgDefaults,
  scanFilesForMultiWordArgDefaults,
} from './cittyArgDefaults'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/**
 * Resolves one argument the way a command body would see it, through the real
 * parser. The declaration shapes below are only worth ruling in or out because
 * of what citty actually does with them, and a hand-built `args` object shows
 * none of it.
 */
const resolve = async (
  name: string,
  declaration: Record<string, unknown>,
  ...argv: string[]
): Promise<unknown> => {
  let seen: unknown
  await runCommand(
    defineCommand({
      args: { [name]: declaration },
      run: ({ args }) => {
        seen = (args as Record<string, unknown>)[name]
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    { rawArgs: argv }
  )
  return seen
}

describe('findMultiWordArgDefaults', () => {
  it('reports a multi-word argument that declares a default', () => {
    const source = `
      const main = defineCommand({
        args: {
          dryRun: { type: 'boolean', description: 'x', default: false },
        },
      })
    `
    expect(findMultiWordArgDefaults('a.ts', source)).toEqual([
      { file: 'a.ts', line: 4, argument: 'dryRun' },
    ])
  })

  it('reports nothing once that same argument drops the default', () => {
    const source = `
      const main = defineCommand({
        args: {
          dryRun: { type: 'boolean', description: 'x' },
        },
      })
    `
    expect(findMultiWordArgDefaults('a.ts', source)).toEqual([])
  })

  it('reports a kebab-spelled declaration too', () => {
    // The defect is symmetric: a body reading `args['dry-run']` loses the value
    // of a caller who typed `--dryRun`.
    const source = `
      defineCommand({ args: { 'dry-run': { type: 'boolean', default: false } } })
    `
    expect(findMultiWordArgDefaults('a.ts', source)).toEqual([
      { file: 'a.ts', line: 2, argument: 'dry-run' },
    ])
  })

  it('reports each offender in a nested subcommand', () => {
    const source = `
      const one = defineCommand({
        args: { useCache: { type: 'boolean', default: true } },
      })
      const main = defineCommand({
        subCommands: {
          two: defineCommand({
            args: { skipConfirmation: { type: 'boolean', default: false } },
          }),
        },
      })
    `
    expect(findMultiWordArgDefaults('a.ts', source)).toEqual([
      { file: 'a.ts', line: 3, argument: 'useCache' },
      { file: 'a.ts', line: 8, argument: 'skipConfirmation' },
    ])
  })

  it('leaves a single-word argument alone, because it has only one spelling', async () => {
    const source = `
      defineCommand({ args: { verbose: { type: 'boolean', default: false } } })
    `
    expect(findMultiWordArgDefaults('a.ts', source)).toEqual([])
    // Ruled out on evidence, not on the name's shape: there is no second key
    // for the default to occupy, so the flag stays reachable.
    expect(await resolve('verbose', { type: 'boolean', default: false })).toBe(
      false
    )
    expect(
      await resolve('verbose', { type: 'boolean', default: false }, '--verbose')
    ).toBe(true)
  })

  it('leaves `default: undefined` alone, because citty installs no default for it', async () => {
    const source = `
      defineCommand({ args: { dryRun: { type: 'boolean', default: undefined } } })
    `
    expect(findMultiWordArgDefaults('a.ts', source)).toEqual([])
    // The distinction that makes the exemption safe: the key stays absent, so
    // the proxy still falls back to the spelling the caller typed.
    expect(
      await resolve(
        'dryRun',
        { type: 'boolean', default: undefined },
        '--dry-run'
      )
    ).toBe(true)
    // Contrast, so the exemption is not just an untested carve-out:
    expect(
      await resolve('dryRun', { type: 'boolean', default: false }, '--dry-run')
    ).toBe(false)
  })

  it.each([
    ['underscore', 'dry_run'],
    ['dot', 'dry.run'],
    ['slash', 'dry/run'],
  ])(
    'reports a name separated by a %s, which citty splits like a capital does',
    async (_label, name) => {
      const source = `
        defineCommand({ args: { '${name}': { type: 'boolean', default: false } } })
      `
      expect(findMultiWordArgDefaults('a.ts', source)).toEqual([
        { file: 'a.ts', line: 2, argument: name },
      ])
      // Flagged on evidence: citty splits on `-`, `_`, `/` and `.` alike, so the
      // default occupies the declared key and `--dry-run` cannot reach the body.
      expect(
        await resolve(name, { type: 'boolean', default: false }, '--dry-run')
      ).toBe(false)
      expect(await resolve(name, { type: 'boolean' }, '--dry-run')).toBe(true)
    }
  )

  it('follows an args block assembled from a same-file const', () => {
    // The shape a shared args block takes in this repo, and the place the next
    // multi-word flag gets added.
    const spread = `
      const sharedArgs = { dryRun: { type: 'boolean', default: false } }
      defineCommand({ args: { ...sharedArgs, file: { type: 'string' } } })
    `
    expect(findMultiWordArgDefaults('a.ts', spread)).toEqual([
      { file: 'a.ts', line: 2, argument: 'dryRun' },
    ])

    const byName = `
      const sharedArgs = { dryRun: { type: 'boolean', default: false } }
      defineCommand({ args: sharedArgs })
    `
    expect(findMultiWordArgDefaults('a.ts', byName)).toEqual([
      { file: 'a.ts', line: 2, argument: 'dryRun' },
    ])
  })

  it('sees through an `as const` when reading the type', () => {
    // `as const` on an args block is idiomatic here (see
    // script/deploy/repair-deployment-records.ts), and a type read literally as
    // `positional' as const` matches nothing, which would report a positional
    // the check means to exempt.
    const source = `
      defineCommand({
        args: { repoRoot: { type: 'positional' as const, default: '.' } },
      })
    `
    expect(findMultiWordArgDefaults('a.ts', source)).toEqual([])
  })

  it('leaves `default: void 0` alone, the other spelling of no default', async () => {
    const source = `
      defineCommand({ args: { dryRun: { type: 'boolean', default: void 0 } } })
    `
    expect(findMultiWordArgDefaults('a.ts', source)).toEqual([])
    expect(
      await resolve('dryRun', { type: 'boolean', default: void 0 }, '--dry-run')
    ).toBe(true)
  })

  it('leaves a positional alone, because dropping its default would make it required', async () => {
    const source = `
      defineCommand({ args: { repoRoot: { type: 'positional', default: '.' } } })
    `
    expect(findMultiWordArgDefaults('a.ts', source)).toEqual([])

    // Exempt because the remedy differs, NOT because the shape is harmless. A
    // flag-shaped argument still loses its value:
    expect(
      await resolve(
        'repoRoot',
        { type: 'positional', default: '.' },
        '--repo-root',
        '/x'
      )
    ).toBe('.')
    // and dropping the default is not the fix — citty then demands it:
    expect(
      resolve('repoRoot', { type: 'positional' }, '--repo-root', '/x')
    ).rejects.toThrow(/Missing required positional/)

    // What it does do correctly, which is why no repo positional is affected:
    expect(
      await resolve('repoRoot', { type: 'positional', default: '.' })
    ).toBe('.')
    expect(
      await resolve('repoRoot', { type: 'positional', default: '.' }, 'here')
    ).toBe('here')
  })

  it('ignores a `default` that is not inside a citty args block', () => {
    const source = `
      await consola.prompt('Continue anyway?', {
        type: 'confirm',
        default: false,
      })
      const notACommand = defineOther({
        args: { dryRun: { type: 'boolean', default: false } },
      })
    `
    expect(findMultiWordArgDefaults('a.ts', source)).toEqual([])
  })
})

describe('every citty command under script/', () => {
  const scriptFiles = (): string[] => {
    const found: string[] = []
    const walk = (relativeDir: string): void => {
      for (const entry of readdirSync(join(REPO_ROOT, relativeDir), {
        withFileTypes: true,
      })) {
        const relativePath = `${relativeDir}/${entry.name}`
        if (entry.isDirectory()) walk(relativePath)
        else if (entry.isFile() && entry.name.endsWith('.ts'))
          found.push(relativePath)
      }
    }
    walk('script')
    return found
  }

  it('declares no `default` on a multi-word argument', () => {
    const files = scriptFiles()
    // Guards the sweep itself: an empty file list would make the assertion
    // below pass while looking at nothing.
    expect(files.length).toBeGreaterThan(100)
    expect(
      files.filter((file) =>
        readFileSync(join(REPO_ROOT, file), 'utf8').includes('defineCommand')
      ).length
    ).toBeGreaterThan(50)

    expect(scanFilesForMultiWordArgDefaults(REPO_ROOT, files)).toEqual([])
  })

  it('would still report one if it were there', () => {
    // Positive control through the same entry point: without it, a scanner
    // blinded outright (reading `meta` instead of `args`, say) leaves the sweep
    // above green.
    const planted = join('script', 'utils', '__citty-arg-defaults-control.ts')
    writeFileSync(
      join(REPO_ROOT, planted),
      "defineCommand({ args: { dryRun: { type: 'boolean', default: false } } })\n"
    )
    try {
      expect(scanFilesForMultiWordArgDefaults(REPO_ROOT, [planted])).toEqual([
        { file: planted, line: 1, argument: 'dryRun' },
      ])
    } finally {
      unlinkSync(join(REPO_ROOT, planted))
    }
  })
})
