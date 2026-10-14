import { expect, test } from 'claude-code/testing'

import { goalFromPrompt, pbiFromBranch, pbiTitle, safeBoardPath } from './register'

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

test('branch names the PBI id, slug kept', () => {
  expect(pbiFromBranch('pbi/016-goal-pin-falls-back')).toEqual({ id: 'PBI-016', slug: 'goal-pin-falls-back' })
  expect(pbiFromBranch('pbi-7-x')).toEqual({ id: 'PBI-007', slug: 'x' })
  expect(pbiFromBranch('PBI-1234-y')).toEqual({ id: 'PBI-1234', slug: 'y' })
  expect(pbiFromBranch('main')).toBeNull()
  expect(pbiFromBranch('HEAD')).toBeNull()
  expect(pbiFromBranch('feature/pbi-016-x')).toBeNull()
})

test('title comes from the board row, null when absent', () => {
  const board = '| ID | Title |\n|---|---|\n| PBI-015 | Other thing | Done |\n| PBI-016 | Fall back to the PBI | Doing |\n'

  expect(pbiTitle(board, 'PBI-016')).toBe('Fall back to the PBI')
  expect(pbiTitle(board, 'PBI-099')).toBeNull()
  expect(pbiTitle('', 'PBI-016')).toBeNull()
})

test('branch edge cases: padding, no slug, case, and names that are not PBIs', () => {
  expect(pbiFromBranch('pbi/7')).toEqual({ id: 'PBI-007', slug: '' })
  expect(pbiFromBranch('pbi-7-')).toEqual({ id: 'PBI-007', slug: '' })
  expect(pbiFromBranch('PBI/7-x')).toEqual({ id: 'PBI-007', slug: 'x' })
  expect(pbiFromBranch('pbi/1234-x')).toEqual({ id: 'PBI-1234', slug: 'x' })
  expect(pbiFromBranch('pbi/abc')).toBeNull()
  expect(pbiFromBranch('feature/pbi-7')).toBeNull()
  expect(pbiFromBranch('')).toBeNull()
})

test('a four-digit zero-padded branch id still finds the three-digit board row', () => {
  const found = pbiFromBranch('pbi/0016-x')

  expect(found?.id).toBe('PBI-016')
  expect(pbiFromBranch('pbi/0-x')?.id).toBe('PBI-000')
  expect(pbiTitle('| PBI-016 | Right row | Doing |\n', found!.id)).toBe('Right row')
})

test('title lookup: numeric id match, extra cells, punctuation, CRLF, prose ignored', () => {
  const board = [
    'PBI-016 is mentioned in a sentence, not a row.',
    '| PBI-1 | Short id | Done |',
    '| PBI-16 | Sixteen, with: punctuation (and more)! | Doing | extra | cells |',
    '',
  ].join('\r\n')

  expect(pbiTitle(board, 'PBI-016')).toBe('Sixteen, with: punctuation (and more)!')
  expect(pbiTitle(board, 'PBI-001')).toBe('Short id')
  expect(pbiTitle('PBI-016 is mentioned in a sentence.\n', 'PBI-016')).toBeNull()
  expect(pbiTitle('| PBI-160 | Other | Doing |\n', 'PBI-016')).toBeNull()
})

test('board path: relative paths pass, absolute, parent and empty ones fall back', () => {
  const dflt = 'docs/backlog/BOARD.md'

  expect(safeBoardPath('work/BOARD.md')).toBe('work/BOARD.md')
  expect(safeBoardPath('/etc/passwd')).toBe(dflt)
  expect(safeBoardPath('../BOARD.md')).toBe(dflt)
  expect(safeBoardPath('a/../b/BOARD.md')).toBe(dflt)
  expect(safeBoardPath('a\\..\\b')).toBe(dflt)
  expect(safeBoardPath('C:\\x\\BOARD.md')).toBe(dflt)
  expect(safeBoardPath('')).toBe(dflt)
  expect(safeBoardPath(null)).toBe(dflt)
})
