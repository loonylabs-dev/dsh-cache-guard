/**
 * Install dsh-cache-guard into a DSH profile and give the guarded preset its
 * engine row.
 *
 *   node tools/install-profile.mjs [--profile web] [--preset cache-guard]
 *                                  [--source standard] [--app <presets dir>]
 *                                  [--mode manual] [--threshold 0.9]
 *                                  [--set-default | --remove-default] [--dry-run]
 *
 * The written preset is an INCLUDE of the shipped composition plus one patch that
 * inserts the engine row into its `compaction` group — `cordis:include` applies
 * `patches` to the entries it reads, and an `insert` patch carrying an `id` pushes
 * rows into that group's child list. A harness update to the shipped preset
 * therefore flows through instead of being frozen in a copy.
 *
 * The preset is available to EVERY profile of the harness home, because the preset
 * roots and the settings document are shared. `--set-default` writes the
 * machine-wide `agent-presets.default`; it is opt-in because that value layers over
 * a profile's own composition default (the studio bundle sets `default: studio`),
 * so it changes which preset every other profile starts with. `--remove-default`
 * takes it back.
 *
 * Idempotent: re-running only fills what is missing.
 *
 * @module dsh-cache-guard/tools/install-profile
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { guardedPresetText } from '../lib/preset-file.js'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const dryRun = argv.includes('--dry-run')
const setDefault = argv.includes('--set-default')
const removeDefault = argv.includes('--remove-default')
const profileName = flag('profile', 'web')
const presetId = flag('preset', 'cache-guard')
const sourceId = flag('source', 'standard')

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profileName)
const installedEngine = join(profileDir, 'node_modules', 'dsh-cache-guard', 'engine.js')
const presetDir = join(home, '.agent-presets', presetId)
const presetFile = join(presetDir, 'agent.cordis.yml')
const settingsFile = join(home, 'settings.yaml')

/** Candidate roots holding the shipped agent presets. */
function shippedPresetRoot(explicit) {
  const candidates = [
    explicit,
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets'),
    join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets'),
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets'),
  ].filter(candidate => typeof candidate === 'string' && candidate !== '')
  return candidates.find(candidate => existsSync(join(candidate, sourceId, 'agent.cordis.yml')))
}

function report(step, detail) {
  console.log(`${dryRun ? '[dry-run] ' : ''}${step}: ${detail}`)
}

if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`profile not found: ${profileDir}`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
report('dependency', manifest.dependencies?.['dsh-cache-guard']
  ?? `MISSING — run: dsh plugin --profile ${profileName} add file:<this package>`)
report('bundle', (manifest.dsh?.profile?.bundles ?? []).includes('dsh-cache-guard')
  ? 'listed in dsh.profile.bundles'
  : 'MISSING from dsh.profile.bundles')
if (!existsSync(installedEngine)) {
  console.error(`installed engine not found: ${installedEngine}`)
  console.error('Install the package into the profile first, then re-run this tool.')
  process.exit(1)
}

const root = shippedPresetRoot(flag('app', undefined))
if (root === undefined) {
  console.error(`could not find the shipped presets (looked for ${sourceId}/agent.cordis.yml); pass --app <agent-presets dir>`)
  process.exit(1)
}
const baseComposition = pathToFileURL(join(root, sourceId, 'agent.cordis.yml')).href
const engineSpecifier = pathToFileURL(installedEngine).href

/** The engine's trigger share, when the command line asks for one. */
const thresholdRatio = Number.parseFloat(flag('threshold', ''))
if (flag('threshold', undefined) !== undefined
  && (!Number.isFinite(thresholdRatio) || thresholdRatio <= 0 || thresholdRatio > 1)) {
  console.error(`--threshold must be a share of the context window in (0, 1], got "${flag('threshold', '')}"`)
  process.exit(1)
}

/** The guarded preset: the shipped composition plus one row inside its compaction group. */
function presetText() {
  return guardedPresetText({
    baseFileUrl: baseComposition,
    engineSpecifier,
    mode: flag('mode', 'manual'),
    ...Number.isFinite(thresholdRatio) ? { thresholdRatio } : {},
  })
}

const existing = existsSync(presetFile) ? readFileSync(presetFile, 'utf8') : ''
const desired = presetText()
if (existing === desired) {
  report('preset', `already current: ${presetFile}`)
} else {
  // The file is generated, so a differing one is out of date rather than
  // hand-made: rebuilding it is how `--mode` and `--threshold` take effect.
  const legacyCopy = !existing.includes('cordis:include') && existing.includes('- id: compaction')
  if (existing === '') report('preset', `${join(root, sourceId)} + engine row -> ${presetFile}`)
  else if (legacyCopy) report('preset', 'replacing a full preset copy with an include-based one')
  else report('preset', `regenerating ${presetFile}`)
  if (!dryRun) {
    mkdirSync(presetDir, { recursive: true })
    if (legacyCopy) copyFileSync(presetFile, `${presetFile}.copy-backup`)
    writeFileSync(presetFile, desired)
  }
}

/**
 * The `agent-presets.default` user setting applies to EVERY profile of this
 * harness home — it layers over a deployment's own composition default (the
 * studio bundle, for instance, sets `default: studio`). Setting it therefore
 * hijacks the default of every other profile, so it is opt-in and reported.
 */
if (removeDefault) {
  if (!existsSync(settingsFile)) {
    report('default preset', 'no settings file; nothing to remove')
  } else {
    const settings = readFileSync(settingsFile, 'utf8')
    const block = /^agent-presets:\s*\n\s+default:\s*(\S+)\n/m.exec(settings)
    if (block === null) report('default preset', 'no agent-presets default to remove')
    else if (block[1] !== presetId) report('default preset', `left alone: it names ${block[1]}, not ${presetId}`)
    else {
      report('default preset', `removing "default: ${presetId}" from ${settingsFile}`)
      if (!dryRun) writeFileSync(settingsFile, settings.replace(block[0], ''))
    }
  }
} else if (!setDefault) {
  report('default preset', `unchanged; pick "${presetId}" per session, or re-run with --set-default`)
} else if (!existsSync(settingsFile)) {
  report('default preset', `no ${settingsFile}; pick "${presetId}" per session`)
} else {
  const settings = readFileSync(settingsFile, 'utf8')
  if (/^agent-presets:/m.test(settings)) {
    const current = /^agent-presets:\s*\n(\s+default:\s*(\S+))/m.exec(settings)
    report('default preset', current === null
      ? 'an agent-presets section exists without a default; set `agent-presets: { default: ' + presetId + ' }` by hand'
      : `already set to ${current[2]} (applies to EVERY profile here)`)
  } else {
    report('default preset', `${presetId} — this applies to EVERY profile of this harness home and overrides a profile's own default`)
    if (!dryRun) writeFileSync(settingsFile, `agent-presets:\n  default: ${presetId}\n${settings}`)
  }
}

console.log(`\n${dryRun ? 'Dry run complete.' : 'Installed.'} The guarded preset is available to every profile of this harness home; the engine half is self-contained, so the installed copy serves them all. A session picks it at start — by the preset chip in the GUI, or as the machine-wide default with --set-default. The log then shows "dsh-cache-guard: engine guarded (mode manual)".`)
