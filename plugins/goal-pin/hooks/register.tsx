import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { GoalInfo } from '../types'

const WIDTH = 110
const MIN_PROMPT = 12

const goal = atom({ plugin: 'goal-pin', key: 'goal' } as const, null)

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

  on('prompt.submit', async ($, e, next) => {
    if ((await read($, goal)) === null) {
      const text = goalFromPrompt(e.text)
      if (text !== null) await update($, goal, () => ({ text, auto: true }))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, goal)
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
