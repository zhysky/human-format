import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
export const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const packageInfo = JSON.parse(
  fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
)
export const packages = {
  oxfmt: ['oxfmt'],
  dprint: ['dprint', '@dprint/typescript', 'dprint-plugin-markup', 'dprint-plugin-malva'],
  biome: ['@biomejs/biome'],
}
export const engines = Object.keys(packages)
export const registry = 'https://registry.npmjs.org'
export const validVersion = value =>
  typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(value)

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function createRuntime(options = {}) {
  const override = options.home ?? process.env.HUMAN_FORMAT_HOME
  const home = path.resolve(override || path.join(os.homedir(), '.local/share/human-format'))
  const prefix = path.join(home, 'engines')
  return {
    home,
    prefix,
    modules: path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules'),
    state: path.join(home, 'state'),
    cache: path.join(home, 'cache'),
    config: path.resolve(
      options.config ||
        process.env.HUMAN_FORMAT_CONFIG_DIR ||
        (override ? path.join(home, 'config') : path.join(os.homedir(), '.config/human-format')),
    ),
  }
}

export function resolvePackage(runtime, name) {
  const installed = path.join(runtime.modules, name, 'package.json')
  return fs.existsSync(installed)
    ? path.dirname(installed)
    : path.dirname(require.resolve(`${name}/package.json`))
}

export function installedVersion(runtime, name) {
  return readJson(path.join(resolvePackage(runtime, name), 'package.json')).version
}

export function engineEntry(runtime, engine) {
  const root = resolvePackage(runtime, packages[engine][0])
  const { bin } = readJson(path.join(root, 'package.json'))
  return path.join(root, typeof bin === 'string' ? bin : bin[engine])
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    ...options,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
      ...options.env,
    },
  })
  if (result.error) throw result.error
  if (result.status === null) throw new Error(`${command} stopped by ${result.signal}`)
  return result
}

export function checkedRun(command, args, options = {}) {
  const { trim = true, ...runOptions } = options
  const result = run(command, args, runOptions)
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed (${result.status}):\n${result.stderr}${result.stdout}`,
    )
  }
  return trim ? result.stdout.trim() : result.stdout
}

export function runEngine(runtime, engine, args, options = {}) {
  return run(process.execPath, [engineEntry(runtime, engine), ...args], {
    ...options,
    env: { DPRINT_CACHE_DIR: path.join(runtime.cache, 'dprint'), ...options.env },
  })
}

export function readPreset(runtime, engine) {
  const personal = path.join(runtime.config, `${engine}.json`)
  return readJson(
    fs.existsSync(personal) ? personal : path.join(packageDir, 'presets', `${engine}.json`),
  )
}

export function createPreset(runtime, engine) {
  const data = readPreset(runtime, engine)
  if (engine === 'dprint') {
    data.plugins = data.plugins.map(plugin => {
      const managed = packages.dprint
        .slice(1)
        .find(
          name =>
            plugin === name ||
            plugin.replaceAll('\\', '/').endsWith(`/node_modules/${name}/plugin.wasm`),
        )
      if (managed) return path.join(resolvePackage(runtime, managed), 'plugin.wasm')
      if (/^https?:\/\//.test(plugin) || path.isAbsolute(plugin)) return plugin
      return path.resolve(runtime.config, plugin)
    })
  }
  fs.mkdirSync(runtime.cache, { recursive: true })
  const directory = fs.mkdtempSync(path.join(runtime.cache, 'preset-'))
  const file = path.join(directory, `${engine}.json`)
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  return { file, data, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

export function npmCli() {
  const nodeDirectory = path.dirname(process.execPath)
  const candidates = [
    process.env.HUMAN_FORMAT_NPM_CLI,
    process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : null,
    path.join(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
  ]
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'))
    const executable = path.join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm')
    if (fs.existsSync(executable)) {
      const real = fs.realpathSync(executable)
      if (real.endsWith('npm-cli.js')) candidates.push(real)
      candidates.push(path.join(path.dirname(real), '../lib/node_modules/npm/bin/npm-cli.js'))
    }
  }
  const file = candidates.find(candidate => candidate && fs.existsSync(candidate))
  if (!file)
    throw new Error('npm was not found. Install npm or set HUMAN_FORMAT_NPM_CLI to npm-cli.js.')
  return file
}

export function runNpm(runtime, args) {
  fs.mkdirSync(runtime.home, { recursive: true })
  return checkedRun(process.execPath, [npmCli(), ...args], {
    cwd: runtime.home,
    timeout: 300_000,
    env: { MISE_SKIP_RESHIM: '1' },
  })
}
