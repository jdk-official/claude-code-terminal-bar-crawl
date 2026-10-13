import { expect, test } from 'claude-code/testing'

import { goalFromPrompt } from './register'

test('goal: first real sentence only', () => {
  expect(goalFromPrompt('  Add a PBI summary to the dashboard\nand more detail')).toBe('Add a PBI summary to the dashboard')
  expect(goalFromPrompt('/dash')).toBeNull()
  expect(goalFromPrompt('yes')).toBeNull()
})

test('goal: long first lines are cut', () => {
  const out = goalFromPrompt('x'.repeat(200))

  expect(out?.length).toBe(110)
  expect(out?.endsWith('…')).toBe(true)
})
