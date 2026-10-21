import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  engines,
  installedVersion,
  packages,
  readJson,
  readPreset,
  registry,
  runNpm,
  validVersion,
} from './runtime.mjs'
import { newRecordDirectory, restore, snapshot, writeRecord } from './state.mjs'
import { verifyEngines } from './verify.mjs'

const npmOptions = [`--registry=${registry}`, '--fetch-retries=1', '--fetch-timeout=20000']
const knownPackages = new Set(Object.values(packages).flat())

export class EngineManager {
  constructor(runtime, services = {}) {
    this.runtime = runtime
    this.log = services.log || console.log
    this.error = services.error || console.error
    this.installed = services.installed || (name => installedVersion(runtime, name))
    this.latest =
      services.latest ||
      (name => {
        const version = JSON.parse(
          runNpm(runtime, [
            'view',
            `${name}@latest`,
            'version',
            '--json',
            '--prefer-online',
            ...npmOptions,
          ]),
        )
        if (!validVersion(version)) throw new Error(`Unexpected npm version for ${name}`)
        return version
      })
    this.install =
      services.install ||
      (versions => {
        const entries = Object.entries(versions)
        if (!entries.length) return
        for (const [name, version] of entries) {
          if (!knownPackages.has(name) || !validVersion(version)) {
            throw new Error(`Invalid formatter package/version: ${name}@${version}`)
          }
        }
        const result = runNpm(runtime, [
          'install',
          '--global',
          '--prefix',
          runtime.prefix,
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          '--engine-strict',
          ...npmOptions,
          ...entries.map(([name, version]) => `${name}@${version}`),
        ])
        if (result) this.log(result)
        for (const [name, version] of entries) {
          if (this.installed(name) !== version)
            throw new Error(`Installed version differs from ${name}@${version}`)
        }
      })
    this.validate = services.validate || (selected => verifyEngines(runtime, selected))
  }

  async update(selected = engines, check = false) {
    const names = selected.flatMap(engine => packages[engine])
    const before = Object.fromEntries(names.map(name => [name, this.installed(name)]))
    const target = {}
    this.log(`Checking npm latest: ${selected.join(', ')}...`)
    for (const name of names) {
      target[name] = await this.latest(name)
      if (!validVersion(target[name])) throw new Error(`Unexpected npm version for ${name}`)
      this.log(
        `  ${name}: ${before[name]} ${before[name] === target[name] ? '(up to date)' : `-> ${target[name]}`}`,
      )
    }
    const pending = Object.fromEntries(
      names.filter(name => before[name] !== target[name]).map(name => [name, target[name]]),
    )
    if (check) {
      this.log(
        `${Object.keys(pending).length} package(s) can be updated. No packages or presets changed.`,
      )
      return 0
    }
    if (!Object.keys(pending).length) {
      this.log('All selected packages already match npm latest.')
      await this.validate(selected)
      return 0
    }

    const directory = newRecordDirectory(path.join(this.runtime.state, 'updates'))
    const file = path.join(directory, 'versions.json')
    const biomeFile = path.join(this.runtime.config, 'biome.json')
    const record = {
      schemaVersion: 1,
      prefix: this.runtime.prefix,
      status: 'running',
      before,
      target,
      rolledBackEngines: [],
    }
    if ('@biomejs/biome' in pending) {
      record.biomeBefore = {
        text: snapshot(biomeFile),
        effective: readPreset(this.runtime, 'biome'),
      }
    }
    writeRecord(file, record)
    this.log(`Updating engines in ${this.runtime.prefix}\nBackup: ${directory}`)
    try {
      await this.install(pending)
      if (record.biomeBefore) {
        writeRecord(biomeFile, {
          ...record.biomeBefore.effective,
          $schema: `https://biomejs.dev/schemas/${target['@biomejs/biome']}/schema.json`,
        })
      }
      await this.validate(selected)
      record.status = 'succeeded'
      writeRecord(file, record)
    } catch (error) {
      this.error(`Update failed: ${error.message}\nRestoring previous versions...`)
      try {
        if (record.biomeBefore) restore(biomeFile, record.biomeBefore.text)
        await this.install(
          Object.fromEntries(Object.keys(pending).map(name => [name, before[name]])),
        )
        await this.validate(selected)
        record.status = 'failed_restored'
        this.error('Previous versions restored; compatibility checks passed.')
      } catch (recoveryError) {
        record.status = 'restore_failed'
        this.error(
          `Automatic restore did not complete: ${recoveryError.message}\nSaved versions: ${file}`,
        )
      }
      writeRecord(file, record)
      return 1
    }
    this.log('Update complete. Formatter compatibility checks passed.')
    return 0
  }

  rollbackRecord(engine) {
    const root = path.join(this.runtime.state, 'updates')
    if (!fs.existsSync(root)) return null
    const records = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(item => item.isDirectory())
      .map(item => path.join(root, item.name, 'versions.json'))
      .sort()
      .reverse()
    for (const file of records) {
      if (!fs.existsSync(file)) continue
      const record = readJson(file)
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(`Invalid update record: ${file}`)
      }
      if (
        record.schemaVersion !== 1 ||
        record.status !== 'succeeded' ||
        record.prefix !== this.runtime.prefix
      )
        continue
      for (const key of ['before', 'target']) {
        if (!record[key] || typeof record[key] !== 'object' || Array.isArray(record[key])) {
          throw new Error(`Invalid version map in update record: ${file}`)
        }
      }
      if (!Array.isArray(record.rolledBackEngines))
        throw new Error(`Invalid rollback state: ${file}`)
      const selected = engines.filter(
        name =>
          (!engine || engine === name) &&
          !record.rolledBackEngines.includes(name) &&
          packages[name].some(
            pkg => pkg in record.target && record.before[pkg] !== record.target[pkg],
          ),
      )
      if (selected.length) return { file, record, selected }
    }
    return null
  }

  async rollback(engine, check = false) {
    const selection = this.rollbackRecord(engine)
    if (!selection) {
      this.log(`No successful update is available to roll back${engine ? ` for ${engine}` : ''}.`)
      this.log('No packages or presets changed.')
      return 0
    }
    const { file, record, selected } = selection
    const names = selected.flatMap(item => packages[item])
    const current = Object.fromEntries(names.map(name => [name, this.installed(name)]))
    const previous = Object.fromEntries(names.map(name => [name, record.before[name]]))
    for (const name of names) {
      if (!validVersion(previous[name]))
        throw new Error(`No valid previous version saved for ${name}`)
      if (current[name] !== record.target[name]) {
        throw new Error(
          `${name}: installed ${current[name]} differs from saved target ${record.target[name]}; rollback stopped without changes`,
        )
      }
    }

    const biomeFile = path.join(this.runtime.config, 'biome.json')
    let biomeCurrent
    let biomeRollback
    if (selected.includes('biome')) {
      if (!record.biomeBefore?.effective) throw new Error('The saved Biome preset is missing')
      biomeCurrent = snapshot(biomeFile)
      const data = readPreset(this.runtime, 'biome')
      const original = record.biomeBefore.effective
      if ('$schema' in original) data.$schema = original.$schema
      else delete data.$schema
      biomeRollback = isDeepStrictEqual(data, original)
        ? record.biomeBefore.text
        : `${JSON.stringify(data, null, 2)}\n`
      if (biomeRollback !== null && typeof biomeRollback !== 'string') {
        throw new Error('The saved Biome preset is invalid')
      }
    }
    this.log(`Rollback update: ${path.basename(path.dirname(file))} (${selected.join(', ')})`)
    for (const name of names) this.log(`  ${name}: ${current[name]} -> ${previous[name]}`)
    if (check) {
      this.log('Preview only. No packages, presets, or rollback records changed.')
      return 0
    }

    const attempt = newRecordDirectory(path.join(path.dirname(file), 'rollbacks'))
    const receiptFile = path.join(attempt, 'versions.json')
    const receipt = { status: 'running', engines: selected, before: current, target: previous }
    writeRecord(receiptFile, receipt)
    if (biomeCurrent !== undefined)
      writeRecord(path.join(attempt, 'biome.json'), { text: biomeCurrent })
    try {
      await this.install(previous)
      if (biomeRollback !== undefined) restore(biomeFile, biomeRollback)
      await this.validate(selected)
      receipt.status = 'succeeded'
      writeRecord(receiptFile, receipt)
      writeRecord(file, {
        ...record,
        rolledBackEngines: [...new Set([...record.rolledBackEngines, ...selected])].sort(),
      })
    } catch (error) {
      this.error(
        `Rollback failed: ${error.message}\nRestoring the versions used before rollback...`,
      )
      try {
        if (biomeCurrent !== undefined) restore(biomeFile, biomeCurrent)
        await this.install(current)
        await this.validate(selected)
        receipt.status = 'failed_restored'
        this.error('Versions used before rollback restored.')
      } catch (recoveryError) {
        receipt.status = 'restore_failed'
        this.error(
          `Automatic restore did not complete: ${recoveryError.message}\nSaved versions: ${receiptFile}`,
        )
      }
      writeRecord(receiptFile, receipt)
      return 1
    }
    this.log('Rollback complete. Formatter compatibility checks passed.')
    return 0
  }
}
