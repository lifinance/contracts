/**
 * Tells a module whether it is the file the user actually executed.
 *
 * The obvious spelling, `import.meta.main`, is unusable here. Node does implement it (22.18+),
 * but `tsx` drops it for `.ts` entry modules: measured `undefined` under the pinned tsx
 * 4.23.13 on Node 18.20.8, 22.23.2 and 26.8.1 alike. The loader decides this, not the Node
 * version — the same tsx reports `true` for a `.mjs` entry, as does a bare `node file.ts` on
 * Node 24+. Since every CLI here is a `.ts` file run through `bunx tsx`, a guard spelled
 * `import.meta.main` never fires on any Node: it exits 0 having done nothing, which to an
 * operator is indistinguishable from a real empty result — an empty timelock queue, a
 * completed cancellation, a finished ownership handover.
 *
 * The plain `process.argv[1] === fileURLToPath(import.meta.url)` compare trades that for a
 * quieter version of the same bug:
 * Node resolves symlinks as it loads, so `import.meta.url` is already the real path while
 * argv[1] stays as the user typed it. Verified both a symlinked file and a symlinked
 * directory component make the plain compare false. No checkout in use today invokes these
 * CLIs through a link, so this is latent rather than firing — but one symlinked directory
 * anywhere above the repo arms it for every script at once, and the failure is a silent
 * `exit 0`, so it would be found by someone trusting an empty result, not by a red test.
 *
 * Callers pass their own `import.meta.url`; it cannot be read from in here.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Whether the calling module is the process entrypoint.
 *
 * @param moduleUrl - The caller's own `import.meta.url`.
 * @returns `true` only when this module is the file being executed directly.
 */
export const isEntrypoint = (moduleUrl: string): boolean => {
  const entry = process.argv[1]
  if (entry === undefined) return false

  try {
    return (
      realpathSync(resolve(entry)) === realpathSync(fileURLToPath(moduleUrl))
    )
  } catch {
    // A path that cannot be resolved is not one we are executing: argv[1] always exists
    // during a direct run, so a throw here means an embedder (`bun -e`, a REPL) with no
    // real entry file.
    return false
  }
}
