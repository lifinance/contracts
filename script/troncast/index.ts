#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

const main = defineCommand({
  meta: {
    name: 'troncast',
    version: '1.0.0',
    description: 'Cast-like CLI tool for Tron blockchain interactions',
  },
  subCommands: {
    call: () => import('./commands/call').then((m) => m.callCommand),
    send: () => import('./commands/send').then((m) => m.sendCommand),
  },
})

runMain(main)
