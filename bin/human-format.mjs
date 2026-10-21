#!/usr/bin/env node
import { main } from '../src/cli.mjs'

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(`human-format: ${error.message}`)
  process.exitCode = 2
}
