import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EngineManager } from '../src/manage.mjs'
import { createRuntime, installedVersion, readJson } from '../src/runtime.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-format-real-versions-'))
try {
  const runtime = createRuntime({ home: root })
  const manager = new EngineManager(runtime)
  console.log('Installing the starting version in an isolated engine directory...')
  await manager.install({ oxfmt: '0.73.0' })
  manager.latest = () => '0.74.0'
  assert.equal(await manager.update(['oxfmt']), 0)
  assert.equal(installedVersion(runtime, 'oxfmt'), '0.74.0')
  const selected = manager.rollbackRecord('oxfmt')
  const before = fs.readFileSync(selected.file, 'utf8')
  assert.equal(await manager.rollback('oxfmt', true), 0)
  assert.equal(fs.readFileSync(selected.file, 'utf8'), before)
  assert.equal(await manager.rollback('oxfmt'), 0)
  assert.equal(installedVersion(runtime, 'oxfmt'), '0.73.0')
  assert.deepEqual(readJson(selected.file).rolledBackEngines, ['oxfmt'])
  console.log('Real npm upgrade and rollback passed: Oxfmt 0.73.0 -> 0.74.0 -> 0.73.0.')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
