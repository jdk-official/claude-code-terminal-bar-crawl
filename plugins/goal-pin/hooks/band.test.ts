import { expect, test } from 'claude-code/testing'

// The band as a person meets it: a first prompt becomes the goal (dim), /goal sets it,
// "clear" removes it and the first prompt is then not taken again.
const BAND = {
  plugin: 'goal-pin',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false } as never,
} as const

const world = (on: Parameters<Parameters<typeof test>[1]>[1]): void => {
  on('command.register', async () => ({ value: { command: 'goal' } }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  // The engine's own (empty) band, beneath the plugin: what `next(e)` reaches when there is no goal.
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
}

test('shows nothing until there is a goal', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...BAND })

  expect(await ui.find({ text: /◎/ })).toBeUndefined()
})

test('the first real prompt becomes the goal, short replies do not', async ($, on) => {
  world(on)
  await $.prompt.submit({ text: 'yes' } as never)
  expect(await (await $.ui.mount({ ...BAND })).find({ text: /◎/ })).toBeUndefined()

  await $.prompt.submit({ text: 'Add a PBI summary to the dashboard' } as never)
  const ui = await $.ui.mount({ ...BAND })

  expect(await ui.find({ text: /Add a PBI summary to the dashboard/ })).toBeDefined()
})

test('/goal sets it, clear removes it, and the next prompt is not taken again', async ($, on) => {
  world(on)
  await $.command.run({ command: 'goal', args: 'Ship the dashboard' } as never)
  const ui = await $.ui.mount({ ...BAND })
  expect(await ui.find({ text: /Ship the dashboard/ })).toBeDefined()

  await ui.press({ key: 'clear' })
  expect(await ui.find({ text: /Ship the dashboard/ })).toBeUndefined()

  await $.prompt.submit({ text: 'Something else entirely, please' } as never)
  expect(await ui.find({ text: /Something else/ })).toBeUndefined()
})

test('hidden while a survey is up', async ($, on) => {
  world(on)
  await $.command.run({ command: 'goal', args: 'Ship the dashboard' } as never)
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: true, isWorking: false } as never })

  expect(await ui.find({ text: /Ship the dashboard/ })).toBeUndefined()
})
