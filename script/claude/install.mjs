#!/usr/bin/env node
// Installs every Claude Code marketplace + plugin pinned in .claude/plugins-lock.json.
// Runs after `bun install` via the postinstall hook and is also invokable
// manually as `bun run claude:install`.
//
// Two-step bootstrap, both idempotent:
//   1. Marketplaces — clone/fetch the source repo into <CONFIG>/plugins/marketplaces/<name>,
//      check out the pinned SHA, register in <CONFIG>/plugins/known_marketplaces.json.
//   2. Plugins — for each "<plugin>@<marketplace>" entry, call `claude plugin install
//      --scope project <spec>` so the CLI populates <CONFIG>/plugins/cache/...
//      and installed_plugins.json. Without step 2 the plugin appears in the marketplace
//      but its skills don't load — that's the "press space in /plugin" gap.
//
// CLAUDE_CONFIG_DIR is honored so users with dual-account setups (e.g. `claude-work`
// aliased to CLAUDE_CONFIG_DIR=~/.claude-work) install into the right config dir.
//
// Fail-soft for environmental errors (missing git or `claude` CLI, network) so it
// never breaks `bun install` for non-Claude users. Hard-fails (exit 1) only on
// pinned-SHA mismatch — that is the tamper-evidence gate.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TAG = '[claude:install]'
const REPO_ROOT = process.cwd()
const LOCK_PATH = path.join(REPO_ROOT, '.claude', 'plugins-lock.json')
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
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

function claudeCli(args) {
  return spawnSync('claude', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE_HOME },
    encoding: 'utf8',
  })
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

function pinMarketplace(name, entry) {
  const { repo, ref, sha } = entry ?? {}
  if (!repo || !ref || !sha) {
    warn(`${name}: missing repo, ref, or sha — skipping`)
    return false
  }
  const url = `https://github.com/${repo}.git`
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
    console.error(`${TAG} ${name}: cannot checkout pinned sha ${sha} — ${e.message?.split('\n')[0] ?? e}`)
    process.exit(1)
  }

  const head = git(['-C', target, 'rev-parse', 'HEAD'])
  if (head !== sha) {
    console.error(`${TAG} ${name}: SHA MISMATCH after checkout. Expected ${sha}, got ${head}.`)
    process.exit(1)
  }

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
    source: { source: 'github', repo, ref, sha },
    installLocation: target,
    lastUpdated: new Date().toISOString(),
  }
  writeJson(KNOWN_FILE, known)

  log(`${name} @ ${ref} (${sha.slice(0, 7)}) ✓`)
  return true
}

function findInstalled(spec) {
  const r = claudeCli(['plugin', 'list', '--json'])
  if (r.status !== 0) return null
  try {
    const list = JSON.parse(r.stdout)
    return list.find((p) => p.id === spec) ?? null
  } catch {
    return null
  }
}

function installPlugin(spec) {
  const at = spec.lastIndexOf('@')
  if (at < 0) {
    warn(`${spec}: invalid plugin spec (expected plugin@marketplace) — skipping`)
    return
  }
  const existing = findInstalled(spec)
  if (existing && existing.enabled) {
    log(`${spec}: already installed (${existing.version}) ✓`)
    return
  }
  log(`${spec}: installing`)
  const r = claudeCli(['plugin', 'install', '--scope', 'project', spec])
  if (r.status !== 0) {
    const err = r.stderr?.trim() || r.stdout?.trim() || `exit ${r.status}`
    warn(`${spec}: install failed — ${err.split('\n')[0]}`)
    return
  }
  log(`${spec}: installed ✓`)
}

function main() {
  if (!fs.existsSync(LOCK_PATH)) {
    log('.claude/plugins-lock.json not found — nothing to install')
    return
  }
  if (!fs.existsSync(CLAUDE_HOME)) {
    log(`${CLAUDE_HOME} not found — Claude Code not installed for this user, skipping`)
    return
  }

  let lock
  try {
    lock = readJson(LOCK_PATH)
  } catch (e) {
    warn(`failed to parse .claude/plugins-lock.json: ${e.message}`)
    return
  }

  const marketplaces = lock.marketplaces ?? {}
  const plugins = lock.plugins ?? []

  for (const name of Object.keys(marketplaces)) {
    try {
      pinMarketplace(name, marketplaces[name])
    } catch (e) {
      warn(`${name}: ${e.message?.split('\n')[0] ?? e}`)
    }
  }

  if (plugins.length === 0) return

  const probe = spawnSync('claude', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  if (probe.status !== 0) {
    warn(`'claude' CLI not on PATH — marketplaces registered, but skipping plugin install. Run 'bun run claude:install' after installing Claude Code.`)
    return
  }

  for (const spec of plugins) {
    try {
      installPlugin(spec)
    } catch (e) {
      warn(`${spec}: ${e.message?.split('\n')[0] ?? e}`)
    }
  }
}

try {
  main()
} catch (e) {
  warn(`unexpected error — ${e.message?.split('\n')[0] ?? e}`)
}
