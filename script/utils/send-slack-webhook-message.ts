#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

import { consola } from 'consola'

import { SlackNotifier } from './slack-notifier'

import 'dotenv/config'

interface IArgs {
  channel: string
  messageFile: string
}

function parseArgs(): IArgs {
  const args = process.argv.slice(2)
  const get = (flag: string): string => {
    const i = args.indexOf(flag)
    if (i === -1 || i === args.length - 1)
      throw new Error(`missing required arg: ${flag}`)
    const value = args[i + 1]
    if (value === undefined)
      throw new Error(`missing required arg value: ${flag}`)
    return value
  }
  const channel = get('--channel').replace(/^#/, '')
  if (!/^[a-z0-9._-]+$/i.test(channel))
    throw new Error(`invalid channel name: ${channel}`)
  return { channel, messageFile: get('--message-file') }
}

async function main(): Promise<void> {
  const { channel, messageFile } = parseArgs()

  const envVar = `WEBHOOK_${channel.replace(/-/g, '_').toUpperCase()}`
  const webhookUrl = process.env[envVar]
  if (!webhookUrl) {
    consola.warn(
      `${envVar} is not set in .env — cannot post to #${channel}.\n` +
        `Add this line to .env (URL from 1Password vault "Developers Smart Contract", item "Webhooks SC Channels"):\n` +
        `  ${envVar}=https://hooks.slack.com/services/...`
    )
    process.exit(2)
  }

  let text: string
  try {
    text = readFileSync(messageFile, 'utf8').trimEnd()
  } catch (err) {
    consola.error(`cannot read message file ${messageFile}:`, err)
    process.exit(1)
  }
  if (!text) {
    consola.error(`message file ${messageFile} is empty`)
    process.exit(1)
  }

  try {
    await new SlackNotifier(webhookUrl).sendNotificationWithRetry(
      { text },
      3,
      true
    )
    consola.success(`posted message to #${channel}`)
  } catch (err) {
    consola.error('Slack post failed:', err)
    process.exit(1)
  }
}

void main()
