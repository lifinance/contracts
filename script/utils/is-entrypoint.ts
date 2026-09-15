/**
 * Tells a module whether it is the file the user actually executed.
 *
 * The obvious spelling, `import.meta.main`, is Bun-only: under `tsx` it is `undefined` on
 * Node below 22.23, which `engines` still permits. A CLI guarded on it then exits 0 having
 * done nothing, which to an operator is indistinguishable from a real empty result — an
 * empty timelock queue, a completed cancellation, a finished ownership handover.
 *
 * The plain `process.argv[1] === fileURLToPath(import.meta.url)` compare that
 * [CONV:NODE-RUNTIME-APIS] prescribes trades that for a quieter version of the same bug:
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
