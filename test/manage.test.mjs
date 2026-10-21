import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EngineManager } from '../src/manage.mjs'
import { createRuntime, engines, packages, readJson } from '../src/runtime.mjs'
import { withOperationLock, writeRecord } from '../src/state.mjs'

function fixture(t, personalPreset = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-format-management-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runtime = createRuntime({ home: root })
  const config = path.join(runtime.config, 'biome.json')
  const original = '{"$schema":"original", "formatter":{"lineWidth":100}}\n'
  if (personalPreset) {
    fs.mkdirSync(runtime.config, { recursive: true })
    fs.writeFileSync(config, original)
  }
  const versions = Object.fromEntries(
    Object.values(packages)
      .flat()
      .map(name => [name, '1.0.0']),
  )
  const installs = []
  const validations = []
  const messages = []
  const manager = new EngineManager(runtime, {
    installed: name => versions[name],
    latest: () => '2.0.0',
    install: values => {
      installs.push({ ...values })
      Object.assign(versions, values)
    },
    validate: selected => {
      validations.push([...selected])
    },
    log: value => messages.push(value),
    error: value => messages.push(value),
  })
  const records = () => {
    const directory = path.join(runtime.state, 'updates')
    return fs.existsSync(directory)
      ? fs
          .readdirSync(directory)
          .sort()
          .map(name => path.join(directory, name, 'versions.json'))
      : []
  }
  return {
    root,
    runtime,
    config,
    original,
    versions,
    installs,
    validations,
    messages,
    manager,
    records,
  }
}

function files(directory) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(item => item.isFile())
    .map(item => {
      const file = path.join(item.parentPath, item.name)
      return [path.relative(directory, file), fs.readFileSync(file, 'utf8')]
    })
    .sort(([a], [b]) => a.localeCompare(b))
}

test('update preview makes no package, configuration or history changes', async t => {
  const f = fixture(t)
  const before = files(f.root)
  assert.equal(await f.manager.update(engines, true), 0)
  assert.deepEqual(f.installs, [])
  assert.deepEqual(f.validations, [])
  assert.deepEqual(files(f.root), before)
})

test('up-to-date engines are validated without adding rollback records', async t => {
  const f = fixture(t)
  f.manager.latest = () => '1.0.0'
  assert.equal(await f.manager.update(), 0)
  assert.deepEqual(f.installs, [])
  assert.deepEqual(f.validations, [engines])
  assert.deepEqual(f.records(), [])
})

test('dprint updates include all plugins and leave other engines untouched', async t => {
  const f = fixture(t)
  assert.equal(await f.manager.update(['dprint']), 0)
  assert.deepEqual(Object.keys(f.installs[0]), packages.dprint)
  assert.equal(f.versions.oxfmt, '1.0.0')
  assert.equal(f.versions['@biomejs/biome'], '1.0.0')
  assert.equal(fs.readFileSync(f.config, 'utf8'), f.original)
  assert.equal(readJson(f.records()[0]).status, 'succeeded')
})

test('Biome update changes the user schema and rollback restores the original text', async t => {
  const f = fixture(t)
  assert.equal(await f.manager.update(['biome']), 0)
  assert.match(readJson(f.config).$schema, /2\.0\.0/)
  assert.equal(await f.manager.rollback('biome'), 0)
  assert.equal(fs.readFileSync(f.config, 'utf8'), f.original)
})

test('a previously absent personal preset is absent again after rollback', async t => {
  const f = fixture(t, false)
  assert.equal(await f.manager.update(['biome']), 0)
  assert.equal(fs.existsSync(f.config), true)
  assert.equal(await f.manager.rollback('biome'), 0)
  assert.equal(fs.existsSync(f.config), false)
})

test('default rollback restores the last successful batch once', async t => {
  const f = fixture(t)
  await f.manager.update()
  assert.equal(await f.manager.rollback(), 0)
  assert.ok(Object.values(f.versions).every(version => version === '1.0.0'))
  assert.deepEqual(readJson(f.records()[0]).rolledBackEngines, [...engines].sort())
  const count = f.installs.length
  assert.equal(await f.manager.rollback(), 0)
  assert.equal(f.installs.length, count)
})

test('partial rollback preserves other engines and keeps remaining work available', async t => {
  const f = fixture(t)
  await f.manager.update()
  assert.equal(await f.manager.rollback('biome'), 0)
  assert.equal(f.versions.oxfmt, '2.0.0')
  assert.equal(f.versions.dprint, '2.0.0')
  assert.equal(f.versions['@biomejs/biome'], '1.0.0')
  assert.deepEqual(readJson(f.records()[0]).rolledBackEngines, ['biome'])
  assert.equal(await f.manager.rollback(), 0)
  assert.ok(Object.values(f.versions).every(version => version === '1.0.0'))
})

test('engine selection finds its own latest update despite newer unrelated updates', async t => {
  const f = fixture(t)
  await f.manager.update()
  f.manager.latest = () => '3.0.0'
  await f.manager.update(['oxfmt'])
  assert.equal(await f.manager.rollback('biome'), 0)
  assert.equal(f.versions.oxfmt, '3.0.0')
  assert.equal(await f.manager.rollback(), 0)
  assert.equal(f.versions.oxfmt, '2.0.0')
  assert.equal(await f.manager.rollback(), 0)
  assert.ok(Object.values(f.versions).every(version => version === '1.0.0'))
})

test('consecutive updates roll back in chronological order', async t => {
  const f = fixture(t)
  await f.manager.update(['oxfmt'])
  f.manager.latest = () => '3.0.0'
  await f.manager.update(['oxfmt'])
  assert.equal(await f.manager.rollback('oxfmt'), 0)
  assert.equal(f.versions.oxfmt, '2.0.0')
  assert.equal(await f.manager.rollback('oxfmt'), 0)
  assert.equal(f.versions.oxfmt, '1.0.0')
})

test('plugin-only updates create a rollback for the complete dprint group', async t => {
  const f = fixture(t)
  f.manager.latest = name => (name === '@dprint/typescript' ? '2.0.0' : '1.0.0')
  await f.manager.update(['dprint'])
  assert.equal(await f.manager.rollback('dprint'), 0)
  assert.deepEqual(Object.keys(f.installs.at(-1)), packages.dprint)
  assert.ok(Object.values(f.versions).every(version => version === '1.0.0'))
})

test('rollback preview leaves source records, presets and versions unchanged', async t => {
  const f = fixture(t)
  await f.manager.update()
  const before = files(f.root)
  const versions = { ...f.versions }
  assert.equal(await f.manager.rollback('biome', true), 0)
  assert.deepEqual(files(f.root), before)
  assert.deepEqual(f.versions, versions)
})

test('empty rollback history does not create files', async t => {
  const f = fixture(t)
  const before = files(f.root)
  assert.equal(await f.manager.rollback(), 0)
  assert.deepEqual(files(f.root), before)
  assert.deepEqual(f.installs, [])
})

test('external version drift stops rollback before writing and leaves unrelated engines selectable', async t => {
  const f = fixture(t)
  await f.manager.update()
  f.versions.dprint = '9.0.0'
  const before = files(f.root)
  await assert.rejects(f.manager.rollback(), /differs from saved target/)
  assert.deepEqual(files(f.root), before)
  assert.equal(await f.manager.rollback('biome'), 0)
  assert.equal(f.versions.dprint, '9.0.0')
})

test('failed update validation restores packages and preset', async t => {
  const f = fixture(t)
  let calls = 0
  f.manager.validate = () => {
    if (!calls++) throw new Error('incompatible')
  }
  assert.equal(await f.manager.update(['biome']), 1)
  assert.equal(f.versions['@biomejs/biome'], '1.0.0')
  assert.equal(fs.readFileSync(f.config, 'utf8'), f.original)
  assert.equal(readJson(f.records()[0]).status, 'failed_restored')
  assert.equal(f.manager.rollbackRecord('biome'), null)
})

test('failed rollback validation restores its starting state and allows retry', async t => {
  const f = fixture(t)
  await f.manager.update(['biome'])
  const current = fs.readFileSync(f.config, 'utf8')
  let calls = 0
  f.manager.validate = () => {
    if (!calls++) throw new Error('incompatible')
  }
  assert.equal(await f.manager.rollback('biome'), 1)
  assert.equal(f.versions['@biomejs/biome'], '2.0.0')
  assert.equal(fs.readFileSync(f.config, 'utf8'), current)
  assert.deepEqual(readJson(f.records()[0]).rolledBackEngines, [])
  assert.equal(await f.manager.rollback('biome'), 0)
})

test('partial installation failure recovers every selected package', async t => {
  const f = fixture(t)
  await f.manager.update(['dprint'])
  f.manager.install = values => {
    if (Object.values(values).every(version => version === '1.0.0')) {
      f.versions.dprint = '1.0.0'
      throw new Error('download failed')
    }
    Object.assign(f.versions, values)
  }
  assert.equal(await f.manager.rollback('dprint'), 1)
  assert.ok(packages.dprint.every(name => f.versions[name] === '2.0.0'))
  assert.deepEqual(readJson(f.records()[0]).rolledBackEngines, [])
})

test('failed automatic recovery is reported without consuming the rollback', async t => {
  const f = fixture(t)
  await f.manager.update(['oxfmt'])
  f.manager.install = () => {
    throw new Error('offline')
  }
  assert.equal(await f.manager.rollback('oxfmt'), 1)
  assert.match(f.messages.join('\n'), /Automatic restore did not complete/)
  assert.deepEqual(readJson(f.records()[0]).rolledBackEngines, [])
})

test('registry errors do not start installations or create history', async t => {
  const f = fixture(t)
  f.manager.latest = () => {
    throw new Error('offline')
  }
  await assert.rejects(f.manager.update(), /offline/)
  assert.deepEqual(f.installs, [])
  assert.deepEqual(f.records(), [])
})

test('rollback preserves later personal formatting preferences', async t => {
  const f = fixture(t)
  await f.manager.update(['biome'])
  const data = readJson(f.config)
  data.formatter.lineWidth = 88
  writeRecord(f.config, data)
  await f.manager.rollback('biome')
  assert.equal(readJson(f.config).$schema, 'original')
  assert.equal(readJson(f.config).formatter.lineWidth, 88)
})

test('corrupt records fail without installing; unverified or other-prefix records are skipped', async t => {
  const f = fixture(t)
  await f.manager.update(['oxfmt'])
  const file = f.records()[0]
  const original = readJson(file)
  const count = f.installs.length
  for (const extra of [
    { status: 'failed_restored' },
    { schemaVersion: 0 },
    { prefix: 'another-runtime' },
  ]) {
    writeRecord(file, { ...original, ...extra })
    assert.equal(await f.manager.rollback(), 0)
    assert.equal(f.installs.length, count)
  }
  writeRecord(file, [])
  await assert.rejects(f.manager.rollback(), /Invalid update record/)
  assert.equal(f.installs.length, count)
})

test('another update or rollback cannot acquire an active operation lock', async t => {
  const f = fixture(t)
  await withOperationLock(f.runtime, async () => {
    await assert.rejects(
      withOperationLock(f.runtime, () => {}),
      /Another update or rollback/,
    )
  })
  await withOperationLock(f.runtime, () => {})
})
