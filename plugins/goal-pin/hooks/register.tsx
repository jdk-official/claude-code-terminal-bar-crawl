import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { GoalInfo } from '../types'

const WIDTH = 110
const MIN_PROMPT = 12

const goal = atom({ plugin: 'goal-pin', key: 'goal' } as const, null)
const pbi = atom({ plugin: 'goal-pin', key: 'pbi' } as const, null)

const BOARD_DEFAULT = 'docs/backlog/BOARD.md'
const GIT_TIMEOUT = 5000

// A branch such as `pbi/7-some-slug` or `pbi-7-some-slug` names a PBI; its id is the number zero-padded to 3 digits.
export function pbiFromBranch(branch: string): { id: string; slug: string } | null {
  const hit = /^pbi[/-](\d+)(?:-(.*))?$/i.exec(branch.trim())
  if (hit === null) return null

  return { id: `PBI-${String(Number(hit[1])).padStart(3, '0')}`, slug: hit[2] ?? '' }
}

// The title cell of the `| PBI-NNN | <title> | ...` board row, or null.
// A small lookup of its own: plugins are isolated packages and cannot import project-dashboard's.
export function pbiTitle(board: string, id: string): string | null {
  const want = Number(id.replace(/\D/g, ''))
  for (const line of board.split('\n')) {
    const hit = /^\s*\|\s*PBI-(\d+)\s*\|\s*([^|]+?)\s*\|/i.exec(line)
    if (hit !== null && Number(hit[1]) === want && hit[2] !== '') return hit[2]!
  }

  return null
}

const configValue = (text: string | null, key: string): string | null =>
  new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(text ?? '')?.[1] ?? null

// Reads the branch and, when it names a PBI, its title; any failure keeps the last value.
// A slow older refresh must not overwrite a newer one: only the latest started may write.
let latest = 0

async function refreshPbi($: any): Promise<void> {
  const mine = ++latest
  try {
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: GIT_TIMEOUT })
    if (head.exitCode !== 0) return
    const found = pbiFromBranch(head.stdout)
    if (found === null) {
      if (mine === latest) await update($, pbi, () => null)

      return
    }

    let title: string | null = null
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT })
    const root = top.exitCode === 0 ? String(top.stdout).trim() : ''
    if (root !== '') {
      const config = await $.fs.read(`${root}/backlog-delivery.config`).catch(() => null)
      const local = await $.fs.read(`${root}/backlog-delivery.local.config`).catch(() => null)
      const path = configValue(local, 'board_path') ?? configValue(config, 'board_path') ?? BOARD_DEFAULT
      const board = await $.fs.read(`${root}/${path}`).catch(() => null)
      if (typeof board === 'string') title = pbiTitle(board, found.id)
    }
    title ??= found.slug.replace(/-/g, ' ')

    const text = title === '' ? found.id : `${found.id} · ${title}`
    if (mine === latest) await update($, pbi, () => ({ text }))
  } catch {
    // Keep the last known value.
  }
}

// The first prompt of a session stands in as the goal until one is set: a real
// sentence, not a slash command or a one-word reply.
export function goalFromPrompt(text: string): string | null {
  const line = text.trim().split('\n')[0] ?? ''
  if (line.startsWith('/') || line.length < MIN_PROMPT) return null

  return line.length > WIDTH ? `${line.slice(0, WIDTH - 1)}…` : line
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'goal',
      description: 'Pin the current goal above the prompt',
      argumentHint: '<text> | clear',
    })
    // Not awaited: git and file reads must not hold up the engine; the state write redraws the band.
    void refreshPbi($)

    return next(e)
  })

  on('command.run', { command: 'goal' }, async ($, e) => {
    const text = e.args.trim()

    if (text === '') {
      const current = await read($, goal)

      return { text: current !== null && current.text !== '' ? `Goal: ${current.text}` : 'No goal pinned. Use /goal <text>.' }
    }

    if (text === 'clear') {
      await update($, goal, () => ({ text: '', auto: false }))

      return { text: 'Goal cleared.' }
    }

    await update($, goal, () => ({ text: text.slice(0, 300), auto: false }))

    return { text: `Goal pinned: ${text}` }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // Not awaited: git and file reads must not hold up the engine; the state write redraws the band.
    void refreshPbi($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if ((await read($, goal)) === null) {
      const text = goalFromPrompt(e.text)
      if (text !== null) await update($, goal, () => ({ text, auto: true }))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const picked = await read($, goal)
    const fallback = await read($, pbi)
    // An explicit `/goal clear` (text '') suppresses the branch fallback as well as the first-prompt goal.
    const current = picked !== null ? picked : fallback === null ? null : { text: fallback.text, auto: true }
    if (e.props.hasSurvey || current === null || current.text === '') return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color="claude">◎ </Text>
        <Text dimColor={current.auto}>{current.text} </Text>
        <Button key="clear" plain label="clear" onPress={() => update($, goal, () => ({ text: '', auto: false }))} />
      </Box>
    )
  })
}
