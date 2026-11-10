/**
 * Loads `.env` into `process.env` without ever replacing a value already set
 * in the shell. Scripts import it for its side effect, in place of
 * `dotenv/config` or a bare `config()` call.
 */

import { config } from 'dotenv'

/**
 * Loads `.env`, keeping every value the shell already set.
 *
 * @remarks dotenv 17+ also takes DOTENV_OVERRIDE from the shell. An explicit
 * option outranks it, so an exported signing key or Mongo URI always beats the
 * file.
 * @returns nothing; fills in `process.env` for names the shell leaves unset
 */
export const loadEnv = (): void => {
  config({ quiet: true, override: false })
}

loadEnv()
