/**
 * Mints `script/deploy/resources/buildAttestations.json` from Foundry artifacts.
 *
 * Run once per checkout with every profile already built into its own `out/`
 * tree. CI attests the file this writes, so the bytes are the artifact: rerun
 * it after any source change and commit the result.
 *
 *   bunx tsx tasks/buildAttestationManifest.ts --builds default=out
 *   bunx tsx tasks/buildAttestationManifest.ts --builds default=out --check
 *
 * `--check` writes nothing and exits non-zero when the committed manifest is
 * not what this checkout produces.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  identityFromArtifactMetadata,
  serialiseAttestationKey,
  sourceClosureHash,
  type IAttestationKey,
} from '../script/deploy/codehash/attestation-key'
import {
  manifestEntryFrom,
  serialiseManifest,
  type IManifestEntry,
  type IMintProfile,
} from '../script/deploy/codehash/build-manifest'
import { parseBuildProfiles } from '../script/deploy/codehash/lineage-scope'

const TARGET = 'script/deploy/resources/buildAttestations.json'
const SOURCE_DIRS = ['src/Facets', 'src/Periphery', 'src/Security']
const VERSION_RE = /@custom:version\s+(\S+)/

interface IBuildInput {
  profile: string
  outDir: string
}

/**
 * Parses `--builds name=dir,name=dir` into the trees to read.
 * @param argv - process arguments
 * @returns One entry per profile built
 */
const parseBuilds = (argv: string[]): IBuildInput[] => {
  const flag = argv.indexOf('--builds')
  const value = flag === -1 ? undefined : argv[flag + 1]
  if (value === undefined)
    throw new Error(
      '--builds <profile>=<outDir>[,<profile>=<outDir>] is required'
    )

  return value.split(',').map((pair) => {
    const [profile, outDir] = pair.split('=')
    if (!profile || !outDir)
      throw new Error(`--builds entry "${pair}" is not <profile>=<outDir>`)
    return { profile, outDir }
  })
}

/** Every contract whose source declares a version, with that version. */
const versionedContracts = (): {
  name: string
  file: string
  version: string
}[] =>
  SOURCE_DIRS.flatMap((dir) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((entry) => entry.endsWith('.sol'))
          .flatMap((entry) => {
            const version = VERSION_RE.exec(
              fs.readFileSync(path.join(dir, entry), 'utf8')
            )?.[1]
            // A source with no `@custom:version` is not a deployable unit here;
            // the key requires a version and inventing one would file a build
            // under a version nothing declares.
            return version === undefined
              ? []
              : [{ name: entry.replace(/\.sol$/, ''), file: entry, version }]
          })
      : []
  )

/**
 * Builds the profile's compiler pair from `foundry.toml`.
 *
 * Read rather than passed in, so a retuned profile cannot be minted under the
 * settings it used to have.
 * @param profile - the profile name as `foundry.toml` spells it
 */
const mintProfile = (profile: string): IMintProfile => {
  const parsed = parseBuildProfiles(fs.readFileSync('foundry.toml', 'utf8'))[
    profile
  ]
  if (parsed === undefined)
    throw new Error(
      `foundry.toml declares no profile "${profile}" pinning both solc and evm versions`
    )

  return {
    profile,
    solcVersion: parsed.solcVersion,
    evmVersion: parsed.evmVersion,
    ...(parsed.zksolcVersion === undefined
      ? {}
      : { zksolcVersion: parsed.zksolcVersion }),
  }
}

/** How many differing lines to print before a reader has seen enough. */
const DRIFT_LINES = 20

/**
 * Prints where the committed manifest and this build part company.
 *
 * Without this the failure says only that two files differ, which on a
 * cross-machine mismatch leaves no way to tell a stale commit from a build that
 * is not reproducible — and those call for opposite responses.
 * @param committed - the manifest as committed
 * @param built - the manifest this checkout produces
 */
const reportDrift = (committed: string, built: string): void => {
  const a = committed.split('\n')
  const b = built.split('\n')
  let shown = 0
  for (
    let i = 0;
    i < Math.max(a.length, b.length) && shown < DRIFT_LINES;
    i++
  ) {
    if (a[i] === b[i]) continue
    console.error(
      `  line ${i + 1}\n    committed: ${a[i] ?? '<eof>'}\n    built:     ${
        b[i] ?? '<eof>'
      }`
    )
    shown++
  }
  console.error(`\n  committed lines: ${a.length}, built lines: ${b.length}`)
}

const main = (): void => {
  const builds = parseBuilds(process.argv)
  const check = process.argv.includes('--check')
  const contracts = versionedContracts()
  const entries: IManifestEntry[] = []
  const skipped: string[] = []

  for (const build of builds) {
    const profile = mintProfile(build.profile)
    for (const contract of contracts) {
      const artifactPath = path.join(
        build.outDir,
        contract.file,
        `${contract.name}.json`
      )
      if (!fs.existsSync(artifactPath)) continue

      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
      const runtimeHex = artifact.deployedBytecode?.object
      // An abstract contract or an interface compiles to nothing. It is not a
      // build to attest, and hashing the empty string would file every one of
      // them under the same masked hash.
      if (typeof runtimeHex !== 'string' || runtimeHex.length <= 2) continue

      const settings = artifact.metadata?.settings
      const sources = artifact.metadata?.sources
      if (settings === undefined || sources === undefined) {
        // zksolc writes no metadata object, so there is no closure to hash and
        // no self-reported settings. Recording it as covered would claim more
        // than was minted.
        skipped.push(
          `${contract.name} (${build.profile}): artifact has no metadata`
        )
        continue
      }

      const identity = identityFromArtifactMetadata(settings)
      const key: IAttestationKey = {
        contractName: contract.name,
        sourceId: identity.sourceId,
        version: contract.version,
        closureHash: sourceClosureHash(
          Object.entries(sources as Record<string, { keccak256: string }>).map(
            ([sourcePath, source]) => ({
              path: sourcePath,
              keccak: source.keccak256,
            })
          )
        ),
        settingsHash: identity.settingsHash,
        settingsSource: identity.settingsSource,
        solcVersion: artifact.metadata.compiler.version,
      }

      const built = manifestEntryFrom(
        {
          contractName: contract.name,
          version: contract.version,
          repo: 'contracts',
        },
        key,
        profile,
        {
          runtimeHex,
          ...(artifact.deployedBytecode.immutableReferences === undefined ||
          Object.keys(artifact.deployedBytecode.immutableReferences).length ===
            0
            ? {}
            : {
                immutableReferences:
                  artifact.deployedBytecode.immutableReferences,
              }),
        },
        identity.hashedSettings
      )
      if (!built.ok) {
        skipped.push(`${contract.name} (${build.profile}): ${built.reason}`)
        continue
      }
      entries.push(built.entry)
    }
  }

  if (entries.length === 0)
    throw new Error(
      'no contract produced a manifest entry — the out/ tree is empty or was built without --ast metadata'
    )

  const text = serialiseManifest(
    builds.map((build) => build.profile),
    entries
  )

  if (check) {
    const committed = fs.existsSync(TARGET)
      ? fs.readFileSync(TARGET, 'utf8')
      : undefined
    if (committed === text) {
      console.log(`${TARGET} is up to date (${entries.length} entries)`)
      return
    }
    console.error(
      `\n❌ ${TARGET} does not match this checkout.\n\n` +
        'CI attests the committed bytes, so a stale manifest is one the attestation no longer covers.\n' +
        'Regenerate and commit:\n\n  bun attestations:mint\n'
    )
    reportDrift(committed ?? '', text)
    process.exit(1)
  }

  fs.mkdirSync(path.dirname(TARGET), { recursive: true })
  fs.writeFileSync(TARGET, text)
  console.log(
    `Wrote ${entries.length} entries across ${builds.length} profile(s) to ${TARGET}`
  )
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length}:`)
    for (const reason of skipped) console.log(`   - ${reason}`)
  }
  // Printed so a reviewer can see what the manifest claims to cover without
  // opening it; the file itself records the same list.
  console.log(
    `Covered profiles: ${[...new Set(builds.map((b) => b.profile))]
      .sort()
      .join(', ')}`
  )
  console.log(
    `Distinct keys: ${
      new Set(entries.map((e) => serialiseAttestationKey(e.key))).size
    }`
  )
}

main()
