#!/usr/bin/env node
// Installs every Claude Code marketplace/plugin declared in .claude/settings.json.
// Generic by design: no hardcoded plugin/marketplace names. Source of truth is
// settings.json. Runs after `bun install` via the postinstall hook and is also
// invokable manually as `bun run claude:install`.
//
// Idempotent. Fail-soft for environmental errors (missing git, network) so it
// never breaks `bun install` for non-Claude users. Hard-fails (exit 1) only on
// pinned-SHA mismatch — that is the tamper-evidence gate the README promises.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TAG = '[claude:install]'
const REPO_ROOT = process.cwd()
const SETTINGS_PATH = path.join(REPO_ROOT, '.claude', 'settings.json')
const CLAUDE_HOME = path.join(os.homedir(), '.claude')
const MARKETPLACES_DIR = path.join(CLAUDE_HOME, 'plugins', 'marketplaces')
const KNOWN_FILE = path.join(CLAUDE_HOME, 'plugins', 'known_marketplaces.json')

function log(msg) {
  console.log(`${TAG} ${msg}`)
}

function warn(msg) {
  console.warn(`${TAG} ${msg}`)
}

function git(args, opts = {}) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    .toString()
    .trim()
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

function resolveSourceUrl(source) {
  if (!source) return null
  if (source.source === 'github' && source.repo) {
    return `https://github.com/${source.repo}.git`
  }
  if (source.url) return source.url
  return null
}

function installMarketplace(name, entry) {
  const source = entry?.source ?? {}
  const url = resolveSourceUrl(source)
  const ref = source.ref
  const sha = source.sha

  if (!url || !ref || !sha) {
    warn(`${name}: missing source.url/repo, ref, or sha — skipping`)
    return
  }

  const target = path.join(MARKETPLACES_DIR, name)
  fs.mkdirSync(MARKETPLACES_DIR, { recursive: true })

  if (!fs.existsSync(target)) {
    log(`${name}: cloning ${url}`)
    git(['clone', '--quiet', url, target])
  } else {
    git(['-C', target, 'fetch', '--quiet', '--tags', 'origin'])
  }

  try {
    git(['-C', target, 'checkout', '--quiet', sha])
  } catch (e) {
    throw new Error(`${name}: failed to checkout pinned sha ${sha} — ${e.message?.split('\n')[0] ?? e}`)
  }

  const head = git(['-C', target, 'rev-parse', 'HEAD'])
  if (head !== sha) {
    // Security gate — hard fail.
    console.error(`${TAG} ${name}: SHA MISMATCH after checkout. Expected ${sha}, got ${head}.`)
    process.exit(1)
  }

  // Merge into known_marketplaces.json idempotently. Schema mirrors what
  // Claude Code's trust prompt writes: flat object keyed by marketplace name,
  // with source/installLocation/lastUpdated fields.
  let known = {}
  if (fs.existsSync(KNOWN_FILE)) {
    try {
      known = readJson(KNOWN_FILE)
    } catch {
      warn(`${KNOWN_FILE} unparseable — overwriting with fresh structure`)
      known = {}
    }
  }
  known[name] = {
    source: { ...source },
    installLocation: target,
    lastUpdated: new Date().toISOString(),
  }
  writeJson(KNOWN_FILE, known)

  const shortSha = sha.slice(0, 7)
  log(`${name} @ ${ref} (${shortSha}) ✓`)
}

function main() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    log('.claude/settings.json not found — nothing to install')
    return
  }
  if (!fs.existsSync(CLAUDE_HOME)) {
    log('~/.claude not found — Claude Code not installed for this user, skipping')
    return
  }

  let settings
  try {
    settings = readJson(SETTINGS_PATH)
  } catch (e) {
    warn(`failed to parse .claude/settings.json: ${e.message}`)
    return
  }

  const marketplaces = settings.extraKnownMarketplaces ?? {}
  const marketplaceNames = Object.keys(marketplaces)
  if (marketplaceNames.length === 0) {
    log('no marketplaces declared in .claude/settings.json — nothing to do')
    return
  }

  for (const name of marketplaceNames) {
    try {
      installMarketplace(name, marketplaces[name])
    } catch (e) {
      // Environmental error (network, missing git, etc.) — warn but continue
      // with other marketplaces. SHA mismatches already exited above.
      warn(`${name}: ${e.message?.split('\n')[0] ?? e}`)
    }
  }

  // Sanity-check enabledPlugins reference known marketplaces.
  const enabled = settings.enabledPlugins ?? {}
  for (const key of Object.keys(enabled)) {
    if (!enabled[key]) continue
    const at = key.lastIndexOf('@')
    if (at < 0) continue
    const marketplace = key.slice(at + 1)
    if (!marketplaces[marketplace]) {
      warn(`enabledPlugins["${key}"] references unknown marketplace "${marketplace}"`)
    }
  }
}

try {
  main()
} catch (e) {
  // Catch-all fail-soft. Hard-fail on SHA mismatch already exited inside.
  warn(`unexpected error — ${e.message?.split('\n')[0] ?? e}`)
}
