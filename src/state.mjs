import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson } from './runtime.mjs'

let lastTimestamp = 0

export function newRecordDirectory(root) {
  fs.mkdirSync(root, { recursive: true })
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1)
  const id = `${new Date(lastTimestamp).toISOString().replace(/[^0-9]/g, '')}-${randomUUID()}`
  const directory = path.join(root, id)
  fs.mkdirSync(directory)
  return directory
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, text)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, file)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    fs.rmSync(temporary, { force: true })
  }
}

export function writeRecord(file, data) {
  writeText(file, `${JSON.stringify(data, null, 2)}\n`)
}

export function snapshot(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

export function restore(file, original) {
  if (original === null) fs.rmSync(file, { force: true })
  else writeText(file, original)
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    return true
  }
}

export async function withOperationLock(runtime, action) {
  fs.mkdirSync(runtime.state, { recursive: true })
  const file = path.join(runtime.state, 'operation.lock')
  let descriptor
  try {
    descriptor = fs.openSync(file, 'wx', 0o600)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let owner
    try {
      owner = readJson(file)
    } catch {
      /* An active writer may still be saving its PID. */
    }
    if (
      owner?.host === os.hostname() &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      !processExists(owner.pid)
    ) {
      fs.rmSync(file)
      descriptor = fs.openSync(file, 'wx', 0o600)
    } else {
      throw new Error(`Another update or rollback is running. Lock: ${file}`)
    }
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, host: os.hostname() }))
    return await action()
  } finally {
    fs.closeSync(descriptor)
    fs.rmSync(file, { force: true })
  }
}
