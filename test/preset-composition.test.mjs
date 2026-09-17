/**
 * The generated preset must actually compose: a real Loader, a real
 * `cordis:include`, and the patch that has to land inside the compaction group.
 *
 *   node test/preset-composition.test.mjs
 *
 * The base composition is a temporary stand-in for the shipped preset: it repeats
 * the shipped shape that matters here (a `cordis:group` with `isolate`, holding
 * the compaction and pruner rows), because a test must not depend on one machine's
 * installed harness. `tools/install-profile.mjs` points the include at the real
 * shipped file.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { guardedPresetText } from '../lib/preset-file.js'

/** A stand-in for the shipped preset: the same compaction group shape. */
const BASE_COMPOSITION = [
  '- id: plain',
  "  name: '@deepseek-ai/dsh-token-meter'",
  '- id: compaction',
  '  name: cordis:group',
  '  group: true',
  '  isolate:',
  '    compaction: true',
  '    toolResultPruner: true',
  '  config:',
  '    - id: compaction-basic',
  "      name: '@deepseek-ai/dsh-compaction-basic'",
  '',
].join('\n')

/** Boot a real Loader over one composition file. */
async function boot(compositionPath, modules) {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(compositionPath).href.replace(/[^/]+$/, '')
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // The app registers `cordis:group` as a builtin beside the include (app-boot).
  ctx.loader.builtins.group = Group
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier) {
      const found = modules.get(specifier)
      if (found === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return found
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(compositionPath).href } })
  await ctx.loader.await()
  return ctx
}

/** Walk every loader entry, including those inside included subtrees. */
function allEntries(ctx) {
  const found = []
  const visit = content => {
    for (const entry of content.entries()) {
      found.push(entry)
      if (entry.subtree?.entries !== undefined) visit(entry.subtree)
    }
  }
  visit(ctx.loader)
  return found
}

describe('generated preset composition', () => {
  it('inserts the guard into the compaction group and keeps the shipped rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cache-guard-preset-'))
    const baseFile = join(root, 'base.cordis.yml')
    const presetFile = join(root, 'agent.cordis.yml')
    await writeFile(baseFile, BASE_COMPOSITION)
    await writeFile(presetFile, guardedPresetText({
      baseFileUrl: pathToFileURL(baseFile).href,
      engineSpecifier: 'file:///guard/engine.js',
      mode: 'manual',
      thresholdRatio: 0.9,
    }))

    // The guard's own module is not in the table; the Loader imports file URLs itself.
    const stub = () => {}
    const ctx = await boot(presetFile, new Map([
      ['@deepseek-ai/dsh-token-meter', stub],
      ['@deepseek-ai/dsh-compaction-basic', stub],
      ['file:///guard/engine.js', stub],
    ]))
    try {
      const entries = allEntries(ctx)
      const ids = entries.map(entry => entry.options.id)
      assert.ok(ids.includes('base'), `the include row must be mounted: ${ids.join(', ')}`)
      assert.ok(ids.includes('compaction-basic'), 'the shipped compaction row must survive the patch')
      const guard = entries.find(entry => entry.options.id === 'cache-guard')
      assert.ok(guard !== undefined, `the guard row must exist: ${ids.join(', ')}`)
      assert.equal(guard.options.name, 'file:///guard/engine.js')
      assert.deepEqual(guard.options.config, { mode: 'manual' })

      // It must sit INSIDE the group: the group's own child list carries it.
      const group = entries.find(entry => entry.options.id === 'compaction')
      assert.ok(Array.isArray(group.options.config), 'the compaction group must keep its child list')
      assert.ok(group.options.config.some(child => child.id === 'cache-guard'),
        'the guard must be a child of the compaction group, not a sibling of it')
      assert.equal(group.options.isolate?.compaction, true, 'the shipped isolation must be preserved')

      // The engine's own trigger is patched on ITS row, not on ours.
      const engine = entries.find(entry => entry.options.id === 'compaction-basic')
      assert.deepEqual(engine.options.config, { thresholdRatio: 0.9 })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
