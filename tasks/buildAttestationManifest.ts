/**
 * Mints `script/deploy/resources/buildAttestations.json` from Foundry artifacts.
 *
 * Run once per checkout with the `default` profile already built into `out/`.
 * CI attests the file this writes, so the bytes are the artifact: rerun it
 * after any source change and commit the result.
 *
 *   bunx tsx tasks/buildAttestationManifest.ts --out out
 *   bunx tsx tasks/buildAttestationManifest.ts --out out --check
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
// Every location `script/deploy/shared/getContractVersion.ts` resolves a
// contract from; keep the two lists in step. A directory missing here takes its
// contracts out of the manifest without putting them in the skip report, which
// is the one failure the skip report cannot tell a reader about. The scan is
// also non-recursive, so a contract in a nested directory is invisible the same
// way.
const SOURCE_DIRS = ['src', 'src/Facets', 'src/Periphery', 'src/Security']
const VERSION_RE = /@custom:version\s+(\S+)/
const PROFILE = 'default'

/**
 * Reads the `out/` tree to mint from.
 * @param argv - process arguments
 * @returns The directory named by `--out`
 */
const parseOutDir = (argv: string[]): string => {
  const flag = argv.indexOf('--out')
  const value = flag === -1 ? undefined : argv[flag + 1]
  if (value === undefined || value.startsWith('--'))
    throw new Error('--out <outDir> is required')
  return value
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
 * Supplies the lineage label and the solc version a build falls back to when
 * its own trailer reports none. Every field the key hashes is read from the
 * artifact instead, so this is not what pins the build's identity.
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

/**
 * Reads the builds a manifest carries, by name and version.
 * @param text - a serialised manifest, possibly unparseable
 * @returns One label per entry, empty when the text is not a manifest
 */
const entryNames = (text: string): string[] => {
  try {
    return (JSON.parse(text).entries as IManifestEntry[]).map(
      (entry) => `${entry.key.contractName}@${entry.key.version}`
    )
  } catch {
    return []
  }
}

/**
 * Names the builds that are on one side of the comparison only.
 *
 * The one question `git diff` on the regenerated file cannot answer at a
 * glance: entries are sorted, so a contract entering or leaving shifts every
 * line after it and the fact that matters is buried in the churn.
 * @param committed - the manifest as committed
 * @param built - the manifest this checkout produces
 */
const reportEntrySetDrift = (committed: string, built: string): void => {
  const inCommitted = new Set(entryNames(committed))
  const inBuilt = new Set(entryNames(built))
  const missing = [...inBuilt].filter((name) => !inCommitted.has(name))
  const stale = [...inCommitted].filter((name) => !inBuilt.has(name))

  for (const name of missing.sort())
    console.error(
      `  this checkout builds ${name}, the committed manifest does not carry it`
    )
  for (const name of stale.sort())
    console.error(
      `  the committed manifest carries ${name}, this checkout does not build it`
    )
}

const main = (): void => {
  const outDir = parseOutDir(process.argv)
  const check = process.argv.includes('--check')
  const contracts = versionedContracts()
  const profile = mintProfile(PROFILE)
  const entries: IManifestEntry[] = []
  const skipped: string[] = []

  for (const contract of contracts) {
    const artifactPath = path.join(
      outDir,
      contract.file,
      `${contract.name}.json`
    )
    if (!fs.existsSync(artifactPath)) {
      skipped.push(`${contract.name}: no artifact under ${outDir}`)
      continue
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
    const runtimeHex = artifact.deployedBytecode?.object
    // An abstract contract or an interface compiles to nothing. It is not a
    // build to attest, and hashing the empty string would file every one of
    // them under the same masked hash.
    if (typeof runtimeHex !== 'string' || runtimeHex.length <= 2) {
      skipped.push(`${contract.name}: compiles to no runtime code`)
      continue
    }

    const settings = artifact.metadata?.settings
    const sources = artifact.metadata?.sources
    if (settings === undefined || sources === undefined) {
      // zksolc writes no metadata object, so there is no closure to hash and
      // no self-reported settings. Recording it as covered would claim more
      // than was minted.
      skipped.push(`${contract.name}: artifact has no metadata`)
      continue
    }

    // Deliberately fatal, unlike the skips above. Those describe artifacts that
    // are legitimately not a build to attest; reaching here with an artifact
    // that names no single compilation target, reports empty settings or
    // carries a malformed source digest means the compiler output itself is not
    // trustworthy, and minting the rest around it would publish a manifest
    // nobody noticed was short. Rethrown with the contract named, since the
    // underlying errors do not say which artifact they choked on.
    let key: IAttestationKey
    let hashedSettings: Record<string, unknown>
    try {
      const identity = identityFromArtifactMetadata(settings)
      hashedSettings = identity.hashedSettings
      key = {
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
    } catch (error) {
      throw new Error(
        `${contract.name} (${artifactPath}): ${
          error instanceof Error ? error.message : String(error)
        }`
      )
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
        Object.keys(artifact.deployedBytecode.immutableReferences).length === 0
          ? {}
          : {
              immutableReferences:
                artifact.deployedBytecode.immutableReferences,
            }),
      },
      hashedSettings
    )
    if (!built.ok) {
      skipped.push(`${contract.name}: ${built.reason}`)
      continue
    }
    entries.push(built.entry)
  }

  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length}:`)
    for (const reason of skipped) console.log(`   - ${reason}`)
  }

  if (entries.length === 0)
    throw new Error(
      skipped.length > 0
        ? `no contract produced a manifest entry — every candidate under ${outDir} was skipped for the reasons above`
        : `no contract produced a manifest entry — ${outDir} is empty or was built without --ast metadata`
    )

  // Safe to name the profile covered only because the throw above proves it
  // contributed. A manifest that lists a profile nothing was minted under tells
  // a reader to grade an honest build under it as a mismatch.
  const text = serialiseManifest([PROFILE], entries)

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
        'Regenerate, then read the change off git:\n\n  bun attestations:mint && git diff -- ' +
        `${TARGET}\n`
    )
    reportEntrySetDrift(committed ?? '', text)
    process.exit(1)
  }

  fs.mkdirSync(path.dirname(TARGET), { recursive: true })
  fs.writeFileSync(TARGET, text)
  console.log(`Wrote ${entries.length} ${PROFILE} entries to ${TARGET}`)
  console.log(
    `Distinct keys: ${
      new Set(entries.map((e) => serialiseAttestationKey(e.key))).size
    }`
  )
}

main()
