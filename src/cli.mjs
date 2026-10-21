import { createRuntime, engines, packageInfo, runEngine } from './runtime.mjs'
import { formatFiles, selectFiles } from './format.mjs'
import { EngineManager } from './manage.mjs'
import { withOperationLock } from './state.mjs'

export function parseArguments(argv) {
  const args = [...argv]
  const action = ['update', 'rollback'].includes(args[0]) ? args.shift() : 'format'
  const result = { action, engine: undefined, files: [], check: false }
  while (args.length) {
    const argument = args.shift()
    if (argument === '--') {
      result.files.push(...args)
      break
    }
    if (argument === '-e' || argument === '--engine' || argument.startsWith('--engine=')) {
      result.engine = (
        argument.startsWith('--engine=') ? argument.slice(9) : args.shift()
      )?.toLowerCase()
      if (!engines.includes(result.engine))
        throw new Error(`Choose an engine: ${engines.join(', ')}`)
    } else if (
      [
        '--check',
        '--version',
        '--tool-version',
        '--list-engines',
        '--list-files',
        '--help',
        '-h',
      ].includes(argument)
    ) {
      result[argument === '-h' ? 'help' : argument.slice(2)] = true
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`)
    } else result.files.push(argument)
  }
  if (
    action !== 'format' &&
    (result.files.length ||
      result.version ||
      result['list-files'] ||
      result['list-engines'] ||
      result['tool-version'])
  ) {
    throw new Error(`${action} accepts only -e/--engine, --check, and --help`)
  }
  return result
}

function printHelp(action) {
  if (action !== 'format') {
    console.log(`Usage: human-format ${action} [-e oxfmt|dprint|biome] [--check]

${
  action === 'update'
    ? 'Update all three engines, or use -e to update one engine.'
    : 'Roll back the latest successful update, or use -e for one engine’s latest update.'
}
dprint includes its TypeScript, markup, and CSS plugins.
--check previews versions without installing or changing presets/history.
Engine packages and history stay in the user directory. Project files are untouched.`)
    return
  }
  console.log(`Usage: human-format [-e ENGINE] [--check] [files...]
       human-format update|rollback [-e ENGINE] [--check]

Default: Oxfmt, staged/unstaged/untracked source files in the current Git repository.
  -e, --engine        oxfmt (default), dprint, or biome
  --check             Check formatting without writing source files
  --list-files        List selected files without formatting
  --list-engines      Show installed engine versions
  --version           Show the selected engine version
  --tool-version      Show the human-format version
  -h, --help          Show this help

Presets live outside the project. The Git index stays unchanged.
Vue preserves unsupported styles and JSX-compatible generic arrow commas.
Biome formats Vue script blocks only, preserving templates and styles.`)
}

export async function main(argv, runtime = createRuntime()) {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 20)) {
    throw new Error('Node.js 22.20.0 or newer is required.')
  }
  const args = parseArguments(argv)
  if (args.help) {
    printHelp(args.action)
    return 0
  }
  if (args.action !== 'format') {
    const manager = new EngineManager(runtime)
    const perform = () =>
      args.action === 'update'
        ? manager.update(args.engine ? [args.engine] : engines, args.check)
        : manager.rollback(args.engine, args.check)
    return args.check ? perform() : withOperationLock(runtime, perform)
  }
  if (args['tool-version']) {
    console.log(packageInfo.version)
    return 0
  }
  const engine = args.engine || 'oxfmt'
  if (args.version || args['list-engines']) {
    for (const name of args['list-engines'] ? engines : [engine]) {
      const result = runEngine(runtime, name, ['--version'])
      console.log(`${name}${name === 'oxfmt' ? ' (default)' : ''}: ${result.stdout.trim()}`)
      if (result.status) {
        process.stderr.write(result.stderr)
        return result.status
      }
    }
    return 0
  }
  const files = selectFiles(args.files)
  if (args['list-files']) {
    for (const file of files) console.log(file)
    return 0
  }
  return formatFiles(runtime, engine, files, args.check)
}
