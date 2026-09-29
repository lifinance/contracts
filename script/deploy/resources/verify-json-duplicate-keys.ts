/**
 * CI entry point for the duplicate-key scanner.
 *
 * Run it over the same files the JSON checker validates: `jsonlint` calls a
 * document with a key twice in it valid, and every parser downstream keeps only
 * the last copy, so without this a requirement can be dropped from a config file
 * while every gate that reads it stays green.
 */

import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { isEntrypoint } from '../../utils/is-entrypoint'

import { findDuplicateKeys, formatDuplicateKey } from './json-duplicate-keys'

const EXIT_FAIL = 1
const EXIT_ERROR = 2

/**
 * Expands the given paths into the JSON files to scan.
 *
 * Skips every symlink, file or directory: a link resolves outside the checked
 * set, so scanning it would report on a file this repo does not necessarily own.
 * The jsonlint step follows a symlinked directory instead, so the caller checks
 * that each path it passes actually yielded files.
 *
 * @param paths - Files or directories, relative to the working directory.
 * @returns Every `.json` file reached, depth-first, in directory order.
 * @throws If a path does not exist, so a typo fails instead of verifying nothing.
 */
export const collectJsonFiles = (paths: readonly string[]): string[] => {
  const files: string[] = []

  for (const path of paths) {
    const stats = lstatSync(path)

    if (stats.isSymbolicLink()) continue

    if (stats.isDirectory()) {
      const entries = readdirSync(path).sort()
      files.push(...collectJsonFiles(entries.map((entry) => join(path, entry))))
      continue
    }

    if (path.endsWith('.json')) files.push(path)
  }

  return files
}

const main = defineCommand({
  meta: {
    name: 'verify-json-duplicate-keys',
    description: 'Fails when a JSON file declares the same key twice',
  },
  args: {
    paths: {
      type: 'positional',
      required: true,
      description: 'JSON files or directories to scan',
    },
  },
  run({ args }) {
    // Every positional lands in `_`, including the one citty assigned to
    // `paths`; reading `paths` alone would scan the first argument only.
    const targets = args._ as string[]

    const files: string[] = []
    for (const target of targets) {
      let reached: string[]
      try {
        reached = collectJsonFiles([target])
      } catch (error) {
        consola.error(`Could not read ${target}: ${String(error)}`)
        process.exit(EXIT_ERROR)
      }

      // Per path, not just overall: a path that is a symlink, or a directory
      // holding no JSON, contributes nothing, and the other paths' files would
      // otherwise let the run report success over a set it never looked at.
      if (reached.length === 0) {
        consola.error(
          `${target} yielded no JSON file to scan. Nothing about it was verified.`
        )
        process.exit(EXIT_ERROR)
      }

      files.push(...reached)
    }

    const messages: string[] = []
    for (const file of files) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch (error) {
        // Exiting here rather than letting the throw escape: citty would end
        // the run with 1, the code this gate uses for 'duplicates found'.
        consola.error(`${file} could not be read: ${String(error)}`)
        process.exit(EXIT_ERROR)
      }

      try {
        for (const duplicate of findDuplicateKeys(text))
          messages.push(formatDuplicateKey(file, duplicate))
      } catch (error) {
        // Only a malformed key reaches here: the scan reads key tokens and never
        // parses, so a truncated document or an unterminated value is invisible
        // to it. The jsonlint step above is what refuses those, over the same paths.
        consola.error(`${file} could not be scanned: ${String(error)}`)
        process.exit(EXIT_ERROR)
      }
    }

    if (messages.length > 0) {
      for (const message of messages) consola.error(message)
      consola.error(
        `${messages.length} duplicate key(s) across ${files.length} file(s).`
      )
      process.exit(EXIT_FAIL)
    }

    consola.success(`No duplicate keys in ${files.length} JSON file(s).`)
  },
})

if (isEntrypoint(import.meta.url)) runMain(main)
