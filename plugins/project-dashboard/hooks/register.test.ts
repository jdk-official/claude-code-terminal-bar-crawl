import { expect, test } from 'claude-code/testing'

import { boardPath, configPath, parseBoard, parseGitStatus, parseListeners, parseOwners, pickDocs, planNext, savedFolds, layeredPath, needsText, pbiFileMap, launchArgv, moveArgv, readOptions, sessionListeners, sessionPbi, summaryText, toggled } from './register'

test('git status: branch, ahead/behind, and change counts', () => {
  const out = '## main...origin/main [ahead 2, behind 1]\n M src/App.tsx\nA  src/new.ts\n?? notes.md\n'

  expect(parseGitStatus(out)).toEqual({
    branch: 'main',
    ahead: 2,
    behind: 1,
    changed: 2,
    untracked: 1,
  })
})

test('git status: no upstream, clean tree', () => {
  expect(parseGitStatus('## feature/x\n')).toEqual({
    branch: 'feature/x',
    ahead: 0,
    behind: 0,
    changed: 0,
    untracked: 0,
  })
})

test('git status: not a status line', () => {
  expect(parseGitStatus('fatal: not a git repository')).toBeNull()
})

test('listeners: ports with their process, deduped across v4/v6, system ports skipped', () => {
  const out = [
    'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=4101,fd=20))',
    'LISTEN 0 511 [::1]:5173 [::]:* users:(("node",pid=4101,fd=21))',
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*',
    'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*',
  ].join('\n')

  expect(parseListeners(out)).toEqual([
    { port: 3000, name: '', pid: 0 },
    { port: 5173, name: 'node', pid: 4101 },
  ])
})

test('owners and session filter: children of the session or processes inside its repo', () => {
  const owners = parseOwners('4101\t/work/repo/app\t0\n4102\t/work/other\t0\n4103\t/tmp\t1\nbad line\n')
  const all = [
    { port: 5173, name: 'node', pid: 4101 },
    { port: 4000, name: 'python', pid: 4102 },
    { port: 9000, name: 'bun', pid: 4103 },
    { port: 8000, name: '', pid: 0 },
  ]

  expect(sessionListeners(all, owners, '/work/repo').map(one => one.port)).toEqual([5173, 9000])
  expect(sessionListeners(all, owners, null).map(one => one.port)).toEqual([9000])
})

const BOARD = [
  '# BOARD',
  '## Proposed',
  '| ID | Title | Depends on | Notes |',
  '|----|-------|------------|-------|',
  '| PBI-008 | Todoist client | PBI-002, PBI-018 | group todoist |',
  '| PBI-009 | Renewals | PBI-008 | group renewals |',
  '| PBI-012 | CalDAV client | PBI-002 | group calendar |',
  '## Ready',
  '| ID | Title | Depends on | Conflict group | Conflict risk |',
  '|----|-------|------------|----------------|---------------|',
  '| PBI-007 | Weather tile | PBI-002 | weather | Low |',
  '| PBI-018 | Repo checks | PBI-002 | quality | Medium |',
  '## In Progress',
  '| ID | Title | Branch |',
  '|----|-------|--------|',
  '| PBI-020 | Tailscale route | pbi-020 |',
  '## Done',
  '| ID | Title | PR |',
  '| PBI-002 | Cache | local merge |',
].join('\n')

test('board: counts per section, deps and risk from each table header', () => {
  const board = parseBoard(BOARD)

  expect(board.counts).toEqual({ Proposed: 3, Ready: 2, 'In Progress': 1, Done: 1 })
  expect(board.active).toEqual([{ id: 'PBI-020', title: 'Tailscale route', section: 'In Progress', deps: [], risk: '', branch: 'pbi-020' }])
  expect(board.items.find(one => one.id === 'PBI-008')).toEqual({
    id: 'PBI-008',
    title: 'Todoist client',
    section: 'Proposed',
    deps: ['PBI-002', 'PBI-018'],
    risk: '',
    branch: '',
  })
  expect(board.items.find(one => one.id === 'PBI-018')?.risk).toBe('Medium')
})

test('plan: unblocked Ready ranked by what they unlock, then risk; waiting nearest first', () => {
  const { next, waiting } = planNext(parseBoard(BOARD).items)

  // 018 unlocks 008 and, through it, 009; 007 unlocks nothing.
  expect(next.map(one => [one.id, one.unlocks])).toEqual([
    ['PBI-018', 2],
    ['PBI-007', 0],
  ])
  // 012 has all deps Done so it is not waiting; 008 waits on 018; 009 on 008.
  expect(waiting).toEqual([
    { id: 'PBI-008', on: ['PBI-018'] },
    { id: 'PBI-009', on: ['PBI-008'] },
  ])
})

test('board and config paths: from config, default otherwise, comments ignored', () => {
  expect(boardPath('board_path = "x/BOARD.md"\n')).toBe('x/BOARD.md')
  expect(boardPath(null)).toBe('docs/backlog/BOARD.md')
  expect(configPath('# adr_dir = "no"\nadr_dir = "docs/decisions"\n', 'adr_dir', 'docs/adr')).toBe('docs/decisions')
  expect(configPath('# adr_dir = "no"\n', 'adr_dir', 'docs/adr')).toBe('docs/adr')
})

test('docs: newest first, README and non-markdown skipped, capped at three', () => {
  const entries = [
    { name: 'README.md', kind: 'file', mtimeMs: 9 },
    { name: '0001-a.md', kind: 'file', mtimeMs: 3 },
    { name: '0002-b.md', kind: 'file', mtimeMs: 1 },
    { name: '0003-c.md', kind: 'file', mtimeMs: 2 },
    { name: '0004-d.md', kind: 'file', mtimeMs: 4 },
    { name: 'notes.txt', kind: 'file', mtimeMs: 8 },
    { name: 'sub', kind: 'dir', mtimeMs: 7 },
  ]

  expect(pickDocs(entries, '/r/docs/adr', 'ADRs', true).map(one => one.name)).toEqual(['0004-d', '0003-c', '0002-b'])
  expect(pickDocs(entries, '/r', 'Root', true, true).map(one => one.name)).toContain('README')
  expect(pickDocs(entries, '/r/docs', 'Docs', false)[0]).toEqual({ path: '/r/docs/0004-d.md', name: '0004-d', group: 'Docs' })
})

test('summary: git, PBI counts, next up and docs as plain lines', () => {
  const out = summaryText(
    'daily-hub',
    { branch: 'main', ahead: 1, behind: 0, changed: 2, untracked: 0 },
    parseBoard(BOARD),
    [{ path: '/r/docs/adr/0001-a.md', name: '0001-a', group: 'ADRs' }],
  )

  expect(out).toContain('Git: main ↑1, 2 modified, 0 new')
  expect(out).toContain('PBIs: 3 proposed · 2 ready · 1 in progress · 1 done')
  expect(out).toContain('next: PBI-018 (unlocks 2)')
  expect(out).toContain('ADRs: /r/docs/adr/0001-a.md')
  expect(out).toContain('Project: daily-hub')
  expect(summaryText(null, null, null, [])).toContain('Nothing to show yet')
})

test('session PBI: by In Progress branch, else by number in branch or worktree folder', () => {
  const items = parseBoard(BOARD).items

  expect(sessionPbi('pbi-020', '', items)?.id).toBe('PBI-020')
  expect(sessionPbi('pbi-007-weather-tile', '', items)?.id).toBe('PBI-007')
  expect(sessionPbi('main', 'daily-hub-pbi-018-repo-checks', items)?.id).toBe('PBI-018')
  expect(sessionPbi('main', 'daily-hub', items)).toBeNull()
  expect(sessionPbi('pbi-999', '', items)).toBeNull()
})

test('toggle: folds a heading, opens it again, leaves the others alone', () => {
  expect(toggled([], 'docs:ADRs')).toEqual(['docs:ADRs'])
  expect(toggled(['docs:ADRs', 'docs'], 'docs:ADRs')).toEqual(['docs'])
})

test('saved folds: only strings of an array survive a round trip through the store', () => {
  expect(savedFolds(['docs', 'docs:ADRs'])).toEqual(['docs', 'docs:ADRs'])
  expect(savedFolds(['docs', 3, null])).toEqual(['docs'])
  expect(savedFolds(undefined)).toEqual([])
  expect(savedFolds({ docs: true })).toEqual([])
})

test('needs text: first three blockers in full, then a count', () => {
  expect(needsText(['PBI-1', 'PBI-2'])).toBe('PBI-1, PBI-2')
  expect(needsText(['PBI-1', 'PBI-2', 'PBI-3', 'PBI-4', 'PBI-5'])).toBe('PBI-1, PBI-2, PBI-3 +2')
})

test('plan: Proposed PBIs with every dependency finished are offered for promotion', () => {
  const { promote } = planNext(parseBoard(BOARD).items)

  // 008 needs 018 (not done) and 009 needs 008; 012 needs only 002, which is Done.
  expect(promote.map(one => one.id)).toEqual(['PBI-012'])
})

test('pbi files: by id from either naming, first file wins', () => {
  const entries = [
    { name: 'PBI-104-widget-grid.md', kind: 'file', mtimeMs: 1 },
    { name: 'PBI-105.md', kind: 'file', mtimeMs: 1 },
    { name: 'PBI-104-duplicate.md', kind: 'file', mtimeMs: 1 },
    { name: 'notes.md', kind: 'file', mtimeMs: 1 },
    { name: 'PBI-1060.md', kind: 'dir', mtimeMs: 1 },
  ]

  expect(pbiFileMap(entries, '/r/pbi')).toEqual({
    'PBI-104': '/r/pbi/PBI-104-widget-grid.md',
    'PBI-105': '/r/pbi/PBI-105.md',
  })
})

test('docs: backlog numbers sort numerically, newest first', () => {
  const entries = [9, 10, 100].map(n => ({ name: `PBI-${n}-x.md`, kind: 'file', mtimeMs: 1 }))

  expect(pickDocs(entries, '/p', 'Backlog', true, false, 12).map(one => one.name)).toEqual([
    'PBI-100-x',
    'PBI-10-x',
    'PBI-9-x',
  ])
})

test('layered config: the local overlay wins key by key, the tracked config fills the rest', () => {
  const tracked = 'board_path = "docs/backlog/BOARD.md"\nadr_dir = "docs/adr"\n'
  const local = 'board_path = "fixtures/dummy-data/backlog/BOARD.md"\n'

  expect(layeredPath(local, tracked, 'board_path', 'x')).toBe('fixtures/dummy-data/backlog/BOARD.md')
  expect(layeredPath(local, tracked, 'adr_dir', 'x')).toBe('docs/adr')
  expect(layeredPath(null, null, 'adr_dir', 'docs/adr')).toBe('docs/adr')
})

test('options: defaults when unset, words split, prefix and move flag honoured', () => {
  expect(readOptions(undefined)).toEqual({
    docOpener: ['xdg-open'],
    browserOpener: ['xdg-open'],
    launchPrefix: [],
    moveToWorkspace: false,
  })
  expect(readOptions({ docOpener: 'code -r', launchPrefix: 'uwsm-app --', moveToWorkspace: true, browserOpener: '' })).toEqual({
    docOpener: ['code', '-r'],
    browserOpener: ['xdg-open'],
    launchPrefix: ['uwsm-app', '--'],
    moveToWorkspace: true,
  })
})

test('launch argv: prefix, opener, target, detached with its own redirects', () => {
  const argv = launchArgv(['uwsm-app', '--'], ['code', '-r'], '/r/doc.md')

  expect(argv.slice(0, 2)).toEqual(['sh', '-c'])
  expect(argv[2]).toContain('setsid -f "$@"')
  expect(argv[2]).toContain('>/dev/null 2>&1 </dev/null')
  expect(argv.slice(4)).toEqual(['uwsm-app', '--', 'code', '-r', '/r/doc.md'])
  expect(moveArgv([], ['xdg-open'], '/r/doc.md').slice(-2)).toEqual(['xdg-open', '/r/doc.md'])
})
