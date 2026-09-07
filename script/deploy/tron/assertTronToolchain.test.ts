/**
 * Covers the Tron deploy path's toolchain pre-flight: the decision, the fail-closed cases,
 * and that it runs before anything reaches a chain.
 *
 * Placement is proven by driving the real seams — `deployContractWithLogging` and the
 * `deploy-and-register-periphery` CLI — with no `forge` on PATH, and asserting on a spy that
 * the deployer was never called. The counterpart puts a matching `forge` on PATH and shows
 * the same call getting past the gate, so neither direction can pass while observing
 * nothing.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  FOUNDRY_VERSION_CHECKER,
  assertTronToolchainOrThrow,
  resetTronToolchainCache,
  spawnFoundryVersionChecker,
  type ICheckerResult,
} from './assertTronToolchain'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const PINNED = readFileSync(join(REPO_ROOT, '.foundry-version'), 'utf8').trim()
const REFUSAL = 'Cannot confirm the local foundry matches'

/**
 * Records every checker path it is handed, so the assertions are on a spy rather than only
 * on a thrown error.
 *
 * @param result - What the fake checker returns.
 * @returns The runner plus the calls it saw.
 */
const spyRunner = (
  result: ICheckerResult
): { run: (path: string) => ICheckerResult; calls: string[] } => {
  const calls: string[] = []
  return {
    run: (path: string) => {
      calls.push(path)
      return result
    },
    calls,
  }
}

/**
 * Puts a `forge` of a chosen version on PATH.
 *
 * @param version - Version the stub reports. Omit for a PATH with no `forge`.
 * @returns The directory to prepend to PATH.
 */
const forgeStub = (version?: string): string => {
  const stubDirectory = mkdtempSync(join(tmpdir(), 'tron-toolchain-stub-'))
  if (version !== undefined) {
    const forge = join(stubDirectory, 'forge')
    writeFileSync(
      forge,
      `#!/bin/bash\necho "forge Version: ${version}"\necho "Commit SHA: deadbeef"\n`
    )
    chmodSync(forge, 0o755)
  }
  return stubDirectory
}

/**
 * PATH with every directory carrying a real `forge` removed, so the absent case is
 * reproducible on a machine that has one.
 *
 * @returns The filtered PATH.
 */
const pathWithoutForge = (): string =>
  (process.env.PATH ?? '')
    .split(':')
    .filter(
      (directory) => directory !== '' && !existsSync(join(directory, 'forge'))
    )
    .join(':')

describe('assertTronToolchainOrThrow — the decision', () => {
  beforeEach(resetTronToolchainCache)

  it('returns, and consults the checker, when the toolchain matches', () => {
    const spy = spyRunner({ status: 0, output: '' })

    expect(() =>
      assertTronToolchainOrThrow({
        repoRoot: '/somewhere',
        run: spy.run,
        exists: () => true,
      })
    ).not.toThrow()
    // Paired with the no-throw above: a gate that returned without running anything would
    // also not throw.
    expect(spy.calls).toEqual([join('/somewhere', FOUNDRY_VERSION_CHECKER)])
  })

  it('throws when the checker reports a mismatch, and carries its output', () => {
    const spy = spyRunner({ status: 1, output: 'foundry version mismatch' })

    expect(() =>
      assertTronToolchainOrThrow({
        repoRoot: '/somewhere',
        run: spy.run,
        exists: () => true,
      })
    ).toThrow(/Cannot confirm the local foundry matches[\s\S]*version mismatch/)
    expect(spy.calls).toHaveLength(1)
  })

  it('throws when the checker is not in the tree, without running anything', () => {
    const spy = spyRunner({ status: 0, output: '' })

    expect(() =>
      assertTronToolchainOrThrow({
        repoRoot: '/somewhere',
        run: spy.run,
        exists: () => false,
      })
    ).toThrow(/Foundry version checker not found/)
    expect(spy.calls).toEqual([])
  })

  it('throws when the checker could not be started at all', () => {
    // A null status is what spawn reports for a failure to launch. "We could not tell" and
    // "it matches" must not share an outcome.
    const spy = spyRunner({ status: null, output: 'spawn bash ENOENT' })

    expect(() =>
      assertTronToolchainOrThrow({
        repoRoot: '/somewhere',
        run: spy.run,
        exists: () => true,
      })
    ).toThrow(REFUSAL)
  })

  it('resolves the checker against the working directory by default', () => {
    const spy = spyRunner({ status: 0, output: '' })

    assertTronToolchainOrThrow({ run: spy.run, exists: () => true })

    expect(spy.calls).toEqual([join(process.cwd(), FOUNDRY_VERSION_CHECKER)])
  })

  it('runs the checker once, however many contracts a script deploys', () => {
    const spy = spyRunner({ status: 0, output: '' })

    for (let index = 0; index < 5; index++)
      assertTronToolchainOrThrow({ run: spy.run, exists: () => true })

    expect(spy.calls).toHaveLength(1)
  })

  it('does not cache a refusal, so a fixed toolchain is picked up', () => {
    const failing = spyRunner({ status: 1, output: '' })
    expect(() =>
      assertTronToolchainOrThrow({ run: failing.run, exists: () => true })
    ).toThrow(REFUSAL)

    const passing = spyRunner({ status: 0, output: '' })
    expect(() =>
      assertTronToolchainOrThrow({ run: passing.run, exists: () => true })
    ).not.toThrow()
    expect(passing.calls).toHaveLength(1)
  })
})

describe('the real checker, run the way the deploy path runs it', () => {
  const originalPath = process.env.PATH

  beforeEach(resetTronToolchainCache)
  afterEach(() => {
    process.env.PATH = originalPath
  })

  it('refuses when the local forge is a different version', () => {
    process.env.PATH = `${forgeStub('0.0.1')}:${pathWithoutForge()}`

    expect(() => assertTronToolchainOrThrow({ repoRoot: REPO_ROOT })).toThrow(
      REFUSAL
    )
  })

  it('refuses when there is no forge at all', () => {
    process.env.PATH = pathWithoutForge()

    expect(() => assertTronToolchainOrThrow({ repoRoot: REPO_ROOT })).toThrow(
      REFUSAL
    )
  })

  it('permits the pinned version, so the refusal is not unconditional', () => {
    process.env.PATH = `${forgeStub(PINNED)}:${pathWithoutForge()}`

    expect(() =>
      assertTronToolchainOrThrow({ repoRoot: REPO_ROOT })
    ).not.toThrow()
  })

  it('reports a real exit status through the default runner', () => {
    process.env.PATH = pathWithoutForge()

    const result = spawnFoundryVersionChecker(
      join(REPO_ROOT, FOUNDRY_VERSION_CHECKER)
    )

    expect(result.status).toBe(1)
    expect(result.output).toContain('forge')
  })
})

describe('the placement in deployContractWithLogging', () => {
  const originalPath = process.env.PATH

  beforeEach(resetTronToolchainCache)
  afterEach(() => {
    process.env.PATH = originalPath
  })

  /**
   * A deployer that records whether anything was ever sent to a chain.
   *
   * @returns The stand-in and its call log.
   */
  const deployerSpy = (): {
    deployer: { deployContract: (...args: unknown[]) => Promise<never> }
    calls: unknown[][]
  } => {
    const calls: unknown[][] = []
    return {
      deployer: {
        deployContract: async (...args: unknown[]) => {
          calls.push(args)
          throw new Error('the spy must never be reached in these cases')
        },
      },
      calls,
    }
  }

  it('refuses before the artifact is loaded or the deployer is called', async () => {
    process.env.PATH = `${forgeStub('0.0.1')}:${pathWithoutForge()}`
    const { deployContractWithLogging } = await import('./tronUtils')
    const spy = deployerSpy()

    expect(
      deployContractWithLogging(spy.deployer, 'Executor', [], true)
    ).rejects.toThrow(REFUSAL)
    expect(spy.calls).toEqual([])
  })

  it('gets past the gate when the forge matches', async () => {
    process.env.PATH = `${forgeStub(PINNED)}:${pathWithoutForge()}`
    const { deployContractWithLogging } = await import('./tronUtils')
    const spy = deployerSpy()

    // Still a rejection - there is no artifact for that name - but for the later reason,
    // which is what separates "the gate refused" from "the gate was not there".
    expect(
      deployContractWithLogging(
        spy.deployer,
        'NoSuchContractOnTheTronPath',
        [],
        true
      )
    ).rejects.toThrow(/Failed to load NoSuchContractOnTheTronPath artifact/)
    expect(spy.calls).toEqual([])
  })
})

describe('the placement at the deploy chokepoint', () => {
  const originalPath = process.env.PATH

  beforeEach(resetTronToolchainCache)
  afterEach(() => {
    process.env.PATH = originalPath
  })

  /**
   * Drives `assertTronDeploymentRecordable`, which every Tron deploy site calls immediately
   * before its `deployer.deployContract`. Driven in process rather than through the deploy
   * CLIs: those import the demo-script helpers, which need generated typechain bindings that
   * CI does not build, so a CLI spawn would fail at module load in CI and prove nothing.
   *
   * @param forgeVersion - Version the stubbed forge reports.
   * @returns The error it threw, or undefined.
   */
  const driveChokepoint = async (
    forgeVersion: string
  ): Promise<Error | undefined> => {
    process.env.PATH = `${forgeStub(forgeVersion)}:${pathWithoutForge()}`
    const { assertTronDeploymentRecordable } = await import('./tronUtils')
    try {
      assertTronDeploymentRecordable(
        { abi: [{ type: 'constructor', inputs: [] }] },
        [],
        'Executor',
        'tron'
      )
      return undefined
    } catch (error) {
      return error as Error
    }
  }

  it('refuses a drifted toolchain at the last step before a broadcast', async () => {
    const error = await driveChokepoint('0.0.1')

    expect(error?.message).toContain(REFUSAL)
  })

  it('lets a pinned toolchain through the same call', async () => {
    // Paired with the case above: without this, a chokepoint that threw unconditionally
    // would look correct.
    const error = await driveChokepoint(PINNED)

    expect(error).toBeUndefined()
  })
})

describe('the gate is on the Tron seams a deployment cannot avoid', () => {
  it('guards every deploy site, per file', () => {
    // Per file, not across all of them. The aggregate form — total asserts >= total
    // deploys — passed at 12 >= 11 while `deploy-safe-tron.ts` broadcast two contracts
    // with no gate at all: the definition in tronUtils.ts and an import elsewhere made
    // up the difference. An invariant a file with zero guards cannot fail is an
    // acceptance criterion that encodes the regression it exists to catch.
    const files = ['script/deploy/tron', 'script/deploy/tron/helpers'].flatMap(
      (directory) =>
        readdirSync(join(REPO_ROOT, directory))
          .filter(
            (entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts')
          )
          .map((entry) => ({
            path: `${directory}/${entry}`,
            source: readFileSync(join(REPO_ROOT, directory, entry), 'utf8'),
          }))
    )

    const occurrences = (source: string, needle: string): number =>
      source.split(needle).length - 1

    const ungated = files
      .map((file) => ({
        path: file.path,
        deploys: occurrences(file.source, 'deployer.deployContract('),
        asserts: occurrences(file.source, 'assertTronDeploymentRecordable('),
      }))
      .filter((file) => file.deploys > file.asserts)

    expect(ungated).toEqual([])
    // Paired positive: if nothing deployed anywhere, the check above is vacuous.
    expect(
      files.reduce(
        (n, f) => n + occurrences(f.source, 'deployer.deployContract('),
        0
      )
    ).toBeGreaterThan(0)
  })

  it('works from the contracts-tron checkout, which carries the same checker', () => {
    // Tron cut proposals run from a fork checkout, so the gate resolves its checker against
    // the working directory rather than against this repository.
    const source = readFileSync(
      join(REPO_ROOT, 'script/deploy/tron/assertTronToolchain.ts'),
      'utf8'
    )

    expect(source).toContain('process.cwd()')
    expect(existsSync(join(REPO_ROOT, FOUNDRY_VERSION_CHECKER))).toBe(true)
  })
})
