#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

const main = defineCommand({
  meta: {
    name: 'troncast',
    version: '1.0.0',
    description: 'Cast-like CLI tool for Tron blockchain interactions',
  },
  subCommands: {
    address: () => import('./commands/address').then((m) => m.addressCommand),
    call: () => import('./commands/call').then((m) => m.callCommand),
    code: () => import('./commands/code').then((m) => m.codeCommand),
    send: () => import('./commands/send').then((m) => m.sendCommand),
  },
})

runMain(main)
