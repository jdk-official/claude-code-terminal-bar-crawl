import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BoardInfo, BoardItem, DocItem, GitInfo, Listener } from '../types'

const PANE = 'project-dashboard'
const POLL_MS = 5000
// Session filtering does the real work; this only skips privileged and system ports.
const DEV_PORTS = { min: 1024, max: 65535 }
const BOARD_DEFAULT = 'docs/backlog/BOARD.md'
const BOARD_ORDER = ['Proposed', 'Ready', 'In Progress', 'In Review', 'Blocked', 'Done']
const BOARD_WATCHED = ['In Progress', 'In Review', 'Blocked']
const RISK_RANK: Record<string, number> = { Low: 0, Medium: 1, High: 2 }
// Options come from plugin.json `userConfig`; these are the values used when none are set.
export type Opts = {
  docOpener: string[]
  browserOpener: string[]
  launchPrefix: string[]
  moveToWorkspace: boolean
}

const words = (value: unknown, fallback: string): string[] => {
  const text = typeof value === 'string' && value.trim() !== '' ? value : fallback

  return text.trim().split(/\s+/).filter(Boolean)
}

export function readOptions(options: unknown): Opts {
  const o = (options ?? {}) as Record<string, unknown>

  return {
    docOpener: words(o.docOpener, 'xdg-open'),
    browserOpener: words(o.browserOpener, 'xdg-open'),
    launchPrefix: typeof o.launchPrefix === 'string' ? words(o.launchPrefix, '') : [],
    moveToWorkspace: o.moveToWorkspace === true,
  }
}

// Launch `prefix opener target` fully detached: `setsid -f` returns at once and its own
// redirects leave nothing holding the engine's pipes, so a click never waits on the viewer.
export const launchArgv = (prefix: string[], opener: string[], target: string): string[] => [
  'sh',
  '-c',
  'setsid -f "$@" >/dev/null 2>&1 </dev/null',
  'launch',
  ...prefix,
  ...opener,
  target,
]

// Hyprland only: note the focused window's workspace, launch, then move the window that
// appears (found by address, any class) onto that workspace. Falls back to a plain launch
// when hyprctl or jq is missing. Args are the command words.
export const MOVE_SCRIPT = `ws=; before=
if command -v hyprctl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  ws=$(hyprctl activewindow -j 2>/dev/null | jq -r '.workspace.id // empty')
  before=" $(hyprctl clients -j 2>/dev/null | jq -r '.[].address' | tr '\\n' ' ') "
fi
setsid -f "$@" >/dev/null 2>&1 </dev/null
[ -z "$ws" ] && exit 0
i=0
while [ $i -lt 40 ]; do
  i=$((i+1)); sleep 0.1
  for a in $(hyprctl clients -j 2>/dev/null | jq -r '.[].address'); do
    case "$before" in *" $a "*) ;; *) hyprctl dispatch movetoworkspacesilent "$ws,address:$a" >/dev/null 2>&1; exit 0 ;; esac
  done
done`

export const moveArgv = (prefix: string[], opener: string[], target: string): string[] => [
  'sh',
  '-c',
  'setsid -f sh -c "$0" _ "$@" >/dev/null 2>&1 </dev/null',
  MOVE_SCRIPT,
  ...prefix,
  ...opener,
  target,
]

const DOC_ORDER = ['Backlog', 'ADRs', 'Handovers', 'Docs']
const DOCS_PER_GROUP = 3
const BACKLOG_SHOWN = 12
const LIST_CAPS = { next: 3, waiting: 4, promote: 4 }

const git = atom({ plugin: 'project-dashboard', key: 'git' } as const, null)
const ports = atom({ plugin: 'project-dashboard', key: 'ports' } as const, [])
const board = atom({ plugin: 'project-dashboard', key: 'board' } as const, null)
const docs = atom({ plugin: 'project-dashboard', key: 'docs' } as const, [])
// The git root of the repo the session last touched a file in, for sessions launched outside one.
const lastRepo = atom({ plugin: 'project-dashboard', key: 'lastRepo' } as const, null)
const pbiFiles = atom({ plugin: 'project-dashboard', key: 'pbiFiles' } as const, {})
const project = atom({ plugin: 'project-dashboard', key: 'project' } as const, null)
const notice = atom({ plugin: 'project-dashboard', key: 'notice' } as const, null)
// Headings the person folded away; empty means everything is open.
const collapsed = atom({ plugin: 'project-dashboard', key: 'collapsed' } as const, [])
const DOCS_KEY = 'docs'

// `git status -sb`: "## main...origin/main [ahead 2, behind 1]" then one line per path.
export function parseGitStatus(out: string): GitInfo | null {
  const lines = out.split('\n').filter(line => line.length > 0)
  const head = lines.shift()
  if (head === undefined || !head.startsWith('## ')) return null

  const text = head.slice(3)
  const branch = text.replace(/^No commits yet on /, '').split('...')[0] ?? text
  const ahead = Number(/ahead (\d+)/.exec(text)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(text)?.[1] ?? 0)
  const untracked = lines.filter(line => line.startsWith('??')).length

  return { branch, ahead, behind, changed: lines.length - untracked, untracked }
}

// `ss -ltnpH`: local address is the fourth column (host:port), the last holds
// `users:(("node",pid=123,fd=20))` for the person's own processes.
export function parseListeners(out: string): Listener[] {
  const found = new Map<number, Listener>()
  for (const line of out.split('\n')) {
    const columns = line.trim().split(/\s+/)
    const local = columns[3]
    const port = Number(local?.slice(local.lastIndexOf(':') + 1))
    if (!(port >= DEV_PORTS.min && port <= DEV_PORTS.max) || found.has(port)) continue

    const owner = /\(\("([^"]*)",pid=(\d+)/.exec(line)
    found.set(port, { port, name: owner?.[1] ?? '', pid: Number(owner?.[2] ?? 0) })
  }

  return [...found.values()].sort((a, b) => a.port - b.port)
}

// One line per pid: `pid<TAB>cwd<TAB>1 when it descends from the engine host`.
export const OWNER_SCRIPT = `host=$PPID
for pid in "$@"; do
  cwd=$(readlink /proc/$pid/cwd 2>/dev/null)
  p=$pid; hit=0
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    if [ "$p" = "$host" ]; then hit=1; break; fi
    p=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null)
  done
  printf '%s\\t%s\\t%s\\n' "$pid" "$cwd" "$hit"
done`

export type Owner = { cwd: string; isChild: boolean }

export function parseOwners(out: string): Map<number, Owner> {
  const owners = new Map<number, Owner>()
  for (const line of out.split('\n')) {
    const [pid, cwd = '', hit = ''] = line.split('\t')
    if (pid !== undefined && /^\d+$/.test(pid)) owners.set(Number(pid), { cwd, isChild: hit === '1' })
  }

  return owners
}

// A server belongs to this session when it was started beneath it, or runs from
// inside the session's repo (a dev server the person started in another terminal).
export function sessionListeners(all: Listener[], owners: Map<number, Owner>, dir: string | null): Listener[] {
  return all.filter(one => {
    const owner = owners.get(one.pid)
    if (owner === undefined) return false

    return owner.isChild || (dir !== null && (owner.cwd === dir || owner.cwd.startsWith(`${dir}/`)))
  })
}

const cellsOf = (line: string): string[] =>
  line
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(cell => cell.trim())

// BOARD.md: the `## Section` a table row sits under is the PBI's status; columns
// differ per section, so each table's header row names them.
export function parseBoard(text: string): BoardInfo {
  const counts: Record<string, number> = {}
  const items: BoardItem[] = []
  let section = ''
  let header: string[] = []

  for (const line of text.split('\n')) {
    const heading = /^## (.+?)\s*$/.exec(line)
    if (heading !== null) {
      section = heading[1] ?? ''
      header = []
      continue
    }
    if (section === '' || !line.startsWith('|')) continue

    const cells = cellsOf(line)
    if (cells[0] === 'ID') {
      header = cells.map(cell => cell.toLowerCase())
      continue
    }

    const id = cells[0] ?? ''
    if (!/^PBI-\d+$/.test(id)) continue

    const col = (name: string): string => cells[header.indexOf(name)] ?? ''
    counts[section] = (counts[section] ?? 0) + 1
    items.push({
      id,
      title: cells[1] ?? '',
      section,
      deps: col('depends on').match(/PBI-\d+/g) ?? [],
      risk: col('conflict risk'),
      branch: col('branch'),
    })
  }

  return { counts, active: items.filter(one => BOARD_WATCHED.includes(one.section)), items }
}

// The PBI this session works on: the In Progress row naming its branch, else the
// PBI number in the branch or worktree folder (`pbi-007-weather-cell-tile`).
export function sessionPbi(branch: string, folder: string, items: BoardItem[]): BoardItem | null {
  const named = branch === '' ? undefined : items.find(one => one.branch !== '' && one.branch === branch)
  if (named !== undefined) return named

  const num = /pbi[-_]?0*(\d+)/i.exec(branch)?.[1] ?? /pbi[-_]?0*(\d+)/i.exec(folder)?.[1]
  if (num === undefined) return null
  const id = `PBI-${num.padStart(3, '0')}`

  return items.find(one => one.id === id) ?? null
}

export type NextUp = { id: string; title: string; unlocks: number }
export type Waiting = { id: string; on: string[] }

// Ready PBIs whose dependencies are all Done, ranked by how much each unblocks
// (transitively), then by conflict risk; and PBIs still waiting, nearest first.
export function planNext(items: BoardItem[]): { next: NextUp[]; waiting: Waiting[]; promote: NextUp[] } {
  const done = new Set(items.filter(one => one.section === 'Done').map(one => one.id))
  const open = items.filter(one => one.section !== 'Done')
  const dependents = new Map<string, string[]>()
  for (const one of open) {
    for (const dep of one.deps) dependents.set(dep, [...(dependents.get(dep) ?? []), one.id])
  }

  const unlocks = (id: string): number => {
    const seen = new Set<string>()
    const queue = [id]
    for (let head = queue.shift(); head !== undefined; head = queue.shift()) {
      for (const child of dependents.get(head) ?? []) {
        if (!seen.has(child)) {
          seen.add(child)
          queue.push(child)
        }
      }
    }

    return seen.size
  }

  const remaining = (one: BoardItem): string[] => one.deps.filter(dep => !done.has(dep))
  const risk = (one: BoardItem): number => RISK_RANK[one.risk] ?? 1
  const ready = open.filter(one => one.section === 'Ready' && remaining(one).length === 0)

  const next = ready
    .map(one => ({ one, unlocks: unlocks(one.id) }))
    .sort((a, b) => b.unlocks - a.unlocks || risk(a.one) - risk(b.one) || a.one.id.localeCompare(b.one.id))
    .map(({ one, unlocks: count }) => ({ id: one.id, title: one.title, unlocks: count }))

  const waiting = open
    .filter(one => (one.section === 'Proposed' || one.section === 'Ready') && remaining(one).length > 0)
    .map(one => ({ id: one.id, on: remaining(one) }))
    .sort((a, b) => a.on.length - b.on.length || a.id.localeCompare(b.id))

  // Proposed PBIs with every dependency finished: nothing stops them being made Ready.
  const promote = open
    .filter(one => one.section === 'Proposed' && remaining(one).length === 0)
    .map(one => ({ id: one.id, title: one.title, unlocks: unlocks(one.id) }))
    .sort((a, b) => b.unlocks - a.unlocks || a.id.localeCompare(b.id))

  return { next, waiting, promote }
}

// A `key = "value"` line from backlog-delivery.config; commented lines never match.
export function configPath(config: string | null, key: string, fallback: string): string {
  return new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(config ?? '')?.[1] ?? fallback
}

export const boardPath = (config: string | null): string => configPath(config, 'board_path', BOARD_DEFAULT)

// The untracked backlog-delivery.local.config overlays the tracked config, key by key.
export const layeredPath = (local: string | null, config: string | null, key: string, fallback: string): string =>
  configPath(local, key, configPath(config, key, fallback))

type Entry = { name: string; kind: string; mtimeMs: number }

// The newest markdown files of one folder: ADRs by their number, others by mtime.
export function pickDocs(
  entries: Entry[],
  dir: string,
  group: string,
  byName: boolean,
  keepReadme = false,
  limit = DOCS_PER_GROUP,
): DocItem[] {
  return entries
    .filter(one => one.kind === 'file' && one.name.endsWith('.md') && (keepReadme || !/^(README|INDEX)\.md$/i.test(one.name)))
    .sort((a, b) => (byName ? b.name.localeCompare(a.name, undefined, { numeric: true }) : b.mtimeMs - a.mtimeMs))
    .slice(0, limit)
    .map(one => ({ path: `${dir}/${one.name}`, name: one.name.replace(/\.md$/, ''), group }))
}

// The pane's content as plain lines, for a surface that draws no panes.
export function summaryText(name: string | null, repo: GitInfo | null, pbis: BoardInfo | null, found: DocItem[]): string {
  const lines: string[] = name === null ? [] : [`Project: ${name}`]
  if (repo !== null) {
    const dirty = repo.changed + repo.untracked
    lines.push(`Git: ${repo.branch}${repo.ahead > 0 ? ` ↑${repo.ahead}` : ''}${repo.behind > 0 ? ` ↓${repo.behind}` : ''}, ${dirty > 0 ? `${repo.changed} modified, ${repo.untracked} new` : 'clean'}`)
  }
  if (pbis !== null) {
    const plan = planNext(pbis.items)
    const mine = sessionPbi(repo?.branch ?? '', name ?? '', pbis.items)
    if (mine !== null) lines.push(`  this session: ${mine.id} (${mine.section}) ${mine.title}`)
    lines.push(`PBIs: ${BOARD_ORDER.filter(name => name in pbis.counts).map(name => `${pbis.counts[name]} ${name.toLowerCase()}`).join(' · ')}`)
    for (const one of plan.next.slice(0, 3)) lines.push(`  next: ${one.id} (unlocks ${one.unlocks}) ${one.title}`)
  }
  for (const one of found) lines.push(`${one.group}: ${one.path}`)

  return lines.length > 0 ? lines.join('\n') : 'Nothing to show yet (not a git repo, or first poll still running).'
}

// Every PBI file by id: `PBI-104-widget-grid.md` and `PBI-104.md` both answer for PBI-104.
export function pbiFileMap(entries: Entry[], dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const one of entries) {
    const id = one.kind === 'file' && one.name.endsWith('.md') ? /^(PBI-\d+)(?:-|\.md$)/.exec(one.name)?.[1] : undefined
    if (id !== undefined && files[id] === undefined) files[id] = `${dir}/${one.name}`
  }

  return files
}

export const toggled = (list: string[], key: string): string[] =>
  list.includes(key) ? list.filter(one => one !== key) : [...list, key]

// What `$.store` hands back is untyped JSON: keep only the strings of an array.
export const savedFolds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []

// "PBI-104, PBI-107 +2": the first few blockers in full, then how many more.
export const needsText = (ids: string[], shown = 3): string =>
  ids.length <= shown ? ids.join(', ') : `${ids.slice(0, shown).join(', ')} +${ids.length - shown}`

const clip = (text: string, width: number): string => (text.length > width ? `${text.slice(0, width - 1)}…` : text)

export const register: Register = (on, options) => {
  const opts = readOptions(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dash',
      description: 'Open the project dashboard pane',
    })

    // Folded headings persist across sessions in the plugin's own store.
    const saved = await $.store.get('collapsed').catch(() => undefined)
    await update($, collapsed, () => savedFolds(saved))

    const refresh = async (): Promise<void> => {
      try {
        // The session's own repo, else the repo of the last file a tool touched.
        const here = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
        const dir = here.exitCode === 0 ? here.stdout.trim() : await read($, lastRepo)

        const status =
          dir === null ? null : await $.process.run(['git', 'status', '-sb'], { cwd: dir, timeoutMs: 5000 })
        const latest = status !== null && status.exitCode === 0 ? parseGitStatus(status.stdout) : null
        await update($, git, prev => (JSON.stringify(prev) === JSON.stringify(latest) ? prev : latest))

        const sockets = await $.process.run(['ss', '-ltnpH'], { timeoutMs: 5000 })
        const listening = sockets.exitCode === 0 ? parseListeners(sockets.stdout) : []
        let open: Listener[] = []
        if (listening.length > 0) {
          const pids = [...new Set(listening.map(one => String(one.pid)).filter(pid => pid !== '0'))]
          const facts = await $.process.run(['sh', '-c', OWNER_SCRIPT, 'owners', ...pids], { timeoutMs: 5000 })
          open = sessionListeners(listening, facts.exitCode === 0 ? parseOwners(facts.stdout) : new Map(), dir)
        }
        await update($, ports, prev => (JSON.stringify(prev) === JSON.stringify(open) ? prev : open))

        let parsed: BoardInfo | null = null
        let found: DocItem[] = []
        let files: Record<string, string> = {}

        if (dir !== null) {
          const config = await $.fs.read(`${dir}/backlog-delivery.config`).catch(() => null)
          const local = await $.fs.read(`${dir}/backlog-delivery.local.config`).catch(() => null)
          const text = await $.fs.read(`${dir}/${layeredPath(local, config, 'board_path', BOARD_DEFAULT)}`).catch(() => null)
          parsed = text === null ? null : parseBoard(text)

          const sources = [
            { path: layeredPath(local, config, 'adr_dir', 'docs/adr'), group: 'ADRs', byName: true },
            { path: layeredPath(local, config, 'handover_dir', 'docs/backlog/handovers'), group: 'Handovers', byName: false },
          ]
          const pbiDir = `${dir}/${layeredPath(local, config, 'pbi_dir', 'docs/backlog/pbi')}`
          const pbiEntries = [...(await $.fs.list(pbiDir).catch(() => []))]
          files = pbiFileMap(pbiEntries, pbiDir)
          found.push(...pickDocs(pbiEntries, pbiDir, 'Backlog', true, false, BACKLOG_SHOWN))

          for (const source of sources) {
            const entries = await $.fs.list(`${dir}/${source.path}`).catch(() => [])
            found.push(...pickDocs([...entries], `${dir}/${source.path}`, source.group, source.byName))
          }
          if (found.length === 0) {
            const entries = await $.fs.list(`${dir}/docs`).catch(() => [])
            found = pickDocs([...entries], `${dir}/docs`, 'Docs', false)
          }
          if (found.length === 0) {
            // A repo with no docs folder: its own top-level notes, README included.
            const entries = await $.fs.list(dir).catch(() => [])
            found = pickDocs([...entries], dir, 'Root', false, true)
          }
        }

        const name = dir === null ? null : (dir.split('/').pop() ?? null)
        await update($, project, prev => (prev === name ? prev : name))
        await update($, pbiFiles, prev => (JSON.stringify(prev) === JSON.stringify(files) ? prev : files))
        await update($, board, prev => (JSON.stringify(prev) === JSON.stringify(parsed) ? prev : parsed))
        await update($, docs, prev => (JSON.stringify(prev) === JSON.stringify(found) ? prev : found))
      } catch {
        // A failed poll keeps the last good values on screen.
      }
    }

    void refresh()
    $.clock.every(POLL_MS, () => void refresh())
    void $.ui.open({ id: PANE, title: 'Project' })

    return next(e)
  })

  on('command.run', { command: 'dash' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Project' })
    const summary = summaryText(await read($, project), await read($, git), await read($, board), await read($, docs))

    if (opened.isPlaced) return { text: `Project dashboard opened.\n${summary}` }

    $.ui.toast('project-dashboard: pane not drawn, see the summary')

    return { text: `Project dashboard pane not drawn: ${opened.reason}\n${summary}` }
  })

  // Remember the repo of the last file Read/Edit/Write touched, so a session launched from ~
  // still follows the project it is working in. Never blocks or alters the call.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const path = (e as { file_path?: unknown }).file_path
    if (typeof path !== 'string' || !['Read', 'Edit', 'Write'].includes(e.tool) || ran.isError === true) return ran

    try {
      const known = await read($, lastRepo)
      if (known !== null && path.startsWith(`${known}/`)) return ran

      const folder = path.slice(0, path.lastIndexOf('/')) || '/'
      const root = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: folder, timeoutMs: 5000 })
      const top = root.exitCode === 0 ? root.stdout.trim() : ''
      if (top !== '') await update($, lastRepo, prev => (prev === top ? prev : top))
    } catch {
      // Tracking is best effort.
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const repo = await read($, git)
    const open = await read($, ports)
    const pbis = await read($, board)
    const found = await read($, docs)
    const files = await read($, pbiFiles)
    const name = await read($, project)
    const last = await read($, notice)
    const shut = await read($, collapsed)

    const plan = pbis === null ? null : planNext(pbis.items)
    const titleOf = (id: string): string => pbis?.items.find(one => one.id === id)?.title ?? ''
    const mine = pbis === null ? null : sessionPbi(repo?.branch ?? '', name ?? '', pbis.items)
    const nextUp = (plan?.next ?? []).slice(0, LIST_CAPS.next)
    const waiting = (plan?.waiting ?? []).slice(0, LIST_CAPS.waiting)
    const promotable = (plan?.promote ?? []).slice(0, LIST_CAPS.promote)
    const more = (all: number, cap: number): string | null => (all > cap ? `+${all - cap} more` : null)

    // A PBI row opens its file when there is one.
    const pbiRow = (id: string, text: string, color: 'success' | 'warning' | 'error' | undefined) => {
      const file = files[id]
      const line = color === undefined ? <Text>{text}</Text> : <Text color={color}>{text}</Text>

      return file === undefined ? (
        line
      ) : (
        <Button key={`pbi-${id}`} plain onPress={() => openDoc(file, id)}>
          {line}
        </Button>
      )
    }
    const groups = DOC_ORDER.filter(group => found.some(one => one.group === group))


    const toggle = (key: string): void => {
      void read($, collapsed).then(async list => {
        const next = toggled(list, key)
        await update($, collapsed, () => next)
        await $.store.set('collapsed', next).catch(() => undefined)
      })
    }

    const topFold = (key: string, label: string) => (
      <Button key={`fold-${key}`} plain onPress={() => toggle(key)}>
        <Text bold color="claude">{`${shut.includes(key) ? '▸' : '▾'} ${label}`}</Text>
      </Button>
    )

    const subFold = (key: string, label: string) => (
      <Button key={`fold-${key}`} plain onPress={() => toggle(key)}>
        <Text dimColor>{`${shut.includes(key) ? '▸' : '▾'} ${label}`}</Text>
      </Button>
    )

    const say = (text: string): void => {
      void update($, notice, () => text)
      $.ui.toast(text)
    }

    // Launched detached with its own redirects: `md` blocks until its window closes
    // and a child holding the engine's pipes would stall the click, so `setsid -f`
    // returns at once and nothing is left attached.
    // Success is silent (the window appearing says it); a failure is shown until the next success.
    const launch = (argv: string[], failed: string): void => {
      void $.process
        .run(argv, { timeoutMs: 5000 })
        .then(ran => {
          if (ran.exitCode === 0) void update($, notice, () => null)
          else say(`${failed}: ${ran.stderr.trim().split('\n')[0] ?? ran.exitCode}`)
        })
        .catch(() => say(failed))
    }

    const openDoc = (path: string, label: string): void => {
      const argv = opts.moveToWorkspace
        ? moveArgv(opts.launchPrefix, opts.docOpener, path)
        : launchArgv(opts.launchPrefix, opts.docOpener, path)
      launch(argv, `Could not open ${label}`)
    }

    const openServer = (port: number): void =>
      launch(
        launchArgv(opts.launchPrefix, opts.browserOpener, `http://localhost:${port}`),
        `Could not open localhost:${port}`,
      )

    return (
      <Box flexDirection="column">
        {topFold('servers', `Dev servers · ${open.length}`)}
        {shut.includes('servers') ? null : open.length === 0 ? (
          <Text dimColor>no servers from this session</Text>
        ) : (
          open.map(one => (
            <Button key={String(one.port)} plain onPress={() => openServer(one.port)}>
              <Text color="success">{`:${one.port}${one.name === '' ? '' : `  ${one.name}`}`}</Text>
            </Button>
          ))
        )}

        {found.length === 0 ? null : (
          <Box flexDirection="column">
            <Text> </Text>
            <Button key={DOCS_KEY} plain onPress={() => toggle(DOCS_KEY)}>
              <Text bold color="claude">{`${shut.includes(DOCS_KEY) ? '▸' : '▾'} Docs · ${found.length}`}</Text>
            </Button>
            {last === null ? null : <Text dimColor>{clip(last, 60)}</Text>}
            {shut.includes(DOCS_KEY)
              ? null
              : groups.map(group => {
                  const items = found.filter(one => one.group === group)
                  const isShut = shut.includes(`${DOCS_KEY}:${group}`)

                  return (
                    <Box flexDirection="column">
                      <Button key={`group-${group}`} plain onPress={() => toggle(`${DOCS_KEY}:${group}`)}>
                        <Text dimColor>{`${isShut ? '▸' : '▾'} ${group} ${items.length}`}</Text>
                      </Button>
                      {isShut
                        ? null
                        : items.map(one => (
                            <Button key={one.path} plain onPress={() => openDoc(one.path, one.name)}>
                              {`  ${clip(one.name, 46)}`}
                            </Button>
                          ))}
                    </Box>
                  )
                })}
          </Box>
        )}

        {pbis === null && name !== null ? (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold color="claude">{`PBIs · ${name}`}</Text>
            <Text dimColor>no BOARD.md in this repo</Text>
          </Box>
        ) : null}

        {pbis === null ? null : (
          <Box flexDirection="column">
            <Text> </Text>
            {topFold('pbis', `PBIs · ${name ?? ''}`)}
            {mine === null
              ? null
              : pbiRow(
                  mine.id,
                  clip(`This session: ${mine.id} · ${mine.section} · ${mine.title}`, 60),
                  mine.section === 'Done' ? 'success' : 'warning',
                )}
            {shut.includes('pbis') ? null : (
              <Box flexDirection="column">
                <Text>
                  {BOARD_ORDER.filter(name => name in pbis.counts)
                    .map(name => `${pbis.counts[name]} ${name.toLowerCase()}`)
                    .join(' · ')}
                </Text>
                {pbis.active.length === 0 ? null : <Text dimColor>In flight</Text>}
                {pbis.active.map(one =>
                  pbiRow(
                    one.id,
                    clip(`${one.id}  ${one.title}  (${one.section.toLowerCase()})`, 60),
                    one.section === 'Blocked' ? 'error' : 'warning',
                  ),
                )}
                {nextUp.length === 0 ? null : (
                  <Box flexDirection="column">
                    {subFold('pbis:next', `Ready to start · ${plan?.next.length ?? 0}`)}
                    {shut.includes('pbis:next') ? null : (
                      <Box flexDirection="column">
                        {nextUp.map(one =>
                          pbiRow(
                            one.id,
                            clip(`${one.id}  ${one.title}${one.unlocks > 0 ? `  · unblocks ${one.unlocks} more` : ''}`, 60),
                            'success',
                          ),
                        )}
                        {more(plan?.next.length ?? 0, LIST_CAPS.next) === null ? null : (
                          <Text dimColor>{more(plan?.next.length ?? 0, LIST_CAPS.next)}</Text>
                        )}
                      </Box>
                    )}
                  </Box>
                )}
                {promotable.length === 0 ? null : (
                  <Box flexDirection="column">
                    {subFold('pbis:promote', `Proposed, ready to promote · ${plan?.promote.length ?? 0}`)}
                    {shut.includes('pbis:promote') ? null : (
                      <Box flexDirection="column">
                        {promotable.map(one =>
                          pbiRow(
                            one.id,
                            clip(`${one.id}  ${one.title}${one.unlocks > 0 ? `  · unblocks ${one.unlocks} more` : ''}`, 60),
                            undefined,
                          ),
                        )}
                        {more(plan?.promote.length ?? 0, LIST_CAPS.promote) === null ? null : (
                          <Text dimColor>{more(plan?.promote.length ?? 0, LIST_CAPS.promote)}</Text>
                        )}
                      </Box>
                    )}
                  </Box>
                )}
                {waiting.length === 0 ? null : (
                  <Box flexDirection="column">
                    {subFold('pbis:waiting', `Waiting on other PBIs · ${plan?.waiting.length ?? 0}`)}
                    {shut.includes('pbis:waiting') ? null : (
                      <Box flexDirection="column">
                        {waiting.map(one =>
                          pbiRow(
                            one.id,
                            clip(`${one.id}  ${titleOf(one.id)}  · needs ${needsText(one.on)}`, 60),
                            undefined,
                          ),
                        )}
                        {more(plan?.waiting.length ?? 0, LIST_CAPS.waiting) === null ? null : (
                          <Text dimColor>{more(plan?.waiting.length ?? 0, LIST_CAPS.waiting)}</Text>
                        )}
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
