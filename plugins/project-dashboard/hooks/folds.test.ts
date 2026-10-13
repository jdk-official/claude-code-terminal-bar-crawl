import { expect, mock, test } from 'claude-code/testing'

// The pane as a person drives it, fed through the mod's own refresh: a fake repo at
// /r with two ADRs, a handover, a board and one dev server. Press a heading and see
// it fold and reach the store; and in a fresh session whose store already holds
// folds, see the pane drawn folded.
const BOARD = [
  '# BOARD',
  '## Proposed',
  '| ID | Title | Depends on | Notes |',
  '|----|-------|------------|-------|',
  '| PBI-3 | Third | PBI-1 | n |',
  '## Ready',
  '| ID | Title | Depends on | Conflict group | Conflict risk |',
  '|----|-------|------------|----------------|---------------|',
  '| PBI-2 | Second | PBI-1 | g | Low |',
  '## Done',
  '| ID | Title | PR |',
  '|----|-------|----|',
  '| PBI-1 | First | merged |',
].join('\n')

const file = (name: string) => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })

const TARGET = {
  plugin: 'project-dashboard',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'project-dashboard',
  props: { title: 'Project' } as never,
} as const

const SS = 'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=4101,fd=20))'

const world = (
  on: Parameters<Parameters<typeof test>[1]>[1],
  store: Record<string, unknown>,
  writes: unknown[] = [],
  runs: string[][] = [],
): void => {
  mock.clock(on)
  // The store, kept here so the test can see every write.
  const kept = new Map(Object.entries(store))
  on('store.get', async (_$, e) => ({ value: kept.get(e.key) }))
  on('store.set', async (_$, e) => {
    kept.set(e.key, e.value)
    writes.push(e.value)

    return { value: undefined }
  })
  mock.env(on, { HOME: '/home/test', XDG_RUNTIME_DIR: '/run/test' })

  // Hooks beneath the plugin answer `{ value }` (or `{ deny }`).
  on('process.run', async (_$, e) => {
    runs.push([...e.argv])
    const [cmd, ...rest] = e.argv
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isTruncated: false } })
    if (cmd === 'git' && rest[0] === 'rev-parse') return out('/r\n')
    if (cmd === 'git') return out('## main\n')
    if (cmd === 'ss') return out(SS)
    if (cmd === 'sh') return out('4101\t/r\t0\n')

    return { value: { exitCode: 1, stdout: '', stderr: '', isTruncated: false } }
  })
  on('fs.read', async (_$, e) =>
    e.path === '/r/docs/backlog/BOARD.md' ? { value: BOARD } : { deny: 'ENOENT' },
  )
  on('fs.list', async (_$, e) => {
    if (e.path === '/r/docs/adr') return { value: [file('0001-a.md'), file('0002-b.md')] }
    if (e.path === '/r/docs/backlog/handovers') return { value: [file('PBI-1.md')] }
    if (e.path === '/r/docs/backlog/pbi') return { value: [file('PBI-1-first.md'), file('PBI-2-second.md'), file('PBI-3-third.md')] }

    return { value: [] }
  })
  on('command.register', async () => ({ value: { command: 'dash' } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.start', async () => ({ cwd: '/r' }))
}

// session.start kicks the first refresh off unawaited; give it a turn to land.
const started = async ($: Parameters<Parameters<typeof test>[1]>[0]): Promise<void> => {
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true } as never)
  await new Promise(resolve => setTimeout(resolve, 50))
}

test('pressing headings folds them and writes the store', async ($, on) => {
  const writes: unknown[] = []
  world(on, {}, writes)
  await started($)
  const ui = await $.ui.mount({ ...TARGET })

  expect(await ui.find({ text: /0001-a/ })).toBeDefined()
  expect(await ui.find({ text: /Ready to start/ })).toBeDefined()
  expect(await ui.find({ text: /:5173/ })).toBeDefined()

  await ui.press({ key: 'group-ADRs' })
  expect(await ui.find({ text: /0001-a/ })).toBeUndefined()
  expect(await ui.find({ text: /▸ ADRs 2/ })).toBeDefined()
  expect(await ui.find({ text: /PBI-1\b/ })).toBeDefined() // handover still open

  await ui.press({ key: 'fold-pbis' })
  expect(await ui.find({ text: /Ready to start/ })).toBeUndefined()
  await ui.press({ key: 'fold-servers' })
  expect(await ui.find({ text: /:5173/ })).toBeUndefined()

  // Each press stored the whole folded list.
  expect(writes.at(-1)).toEqual(['docs:ADRs', 'pbis', 'servers'])

  await ui.press({ key: 'group-ADRs' })
  expect(await ui.find({ text: /0001-a/ })).toBeDefined()
  expect(writes.at(-1)).toEqual(['pbis', 'servers'])
})

test('a fresh session reads the saved folds and draws them folded', async ($, on) => {
  world(on, { collapsed: ['docs:ADRs', 'pbis', 'servers'] })
  await started($)
  const ui = await $.ui.mount({ ...TARGET })

  expect(await ui.find({ text: /0001-a/ })).toBeUndefined()
  expect(await ui.find({ text: /▸ ADRs 2/ })).toBeDefined()
  expect(await ui.find({ text: /Ready to start/ })).toBeUndefined()
  expect(await ui.find({ text: /:5173/ })).toBeUndefined()
  expect(await ui.find({ text: /▸ PBIs/ })).toBeDefined()
  expect(await ui.find({ text: /▸ Dev servers/ })).toBeDefined()
  expect(await ui.find({ text: /Handovers/ })).toBeDefined() // not folded
})

test('the backlog is listed and PBI rows open their file', async ($, on) => {
  const runs: string[][] = []
  world(on, {}, [], runs)
  await started($)
  const ui = await $.ui.mount({ ...TARGET })

  // Backlog group: newest first, openable like any doc.
  expect(await ui.find({ text: /▾ Backlog 3/ })).toBeDefined()
  expect(await ui.find({ text: /PBI-3-third/ })).toBeDefined()

  // PBI-3 depends only on a finished PBI, so it is offered for promotion.
  expect(await ui.find({ text: /Proposed, ready to promote · 1/ })).toBeDefined()

  // Pressing a PBI row launches its file through the detached opener.
  runs.length = 0
  await ui.press({ key: 'pbi-PBI-2' })
  const opened = runs.find(argv => argv.includes('/r/docs/backlog/pbi/PBI-2-second.md'))
  expect(opened).toBeDefined()
  expect(opened?.[0]).toBe('sh')
})
