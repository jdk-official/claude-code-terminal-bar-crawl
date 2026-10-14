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

// The fallback: with no goal, the band shows the PBI the git branch names (dim).
const branchWorld = (on: Parameters<Parameters<typeof test>[1]>[1], branch: string, board: string | null): void => {
  world(on)
  on('session.start', async () => ({ cwd: '/r' }))
  on('process.run', async (_$, e) => {
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isTruncated: false } })
    if (e.argv.includes('--abbrev-ref')) return out(`${branch}\n`)
    if (e.argv.includes('--show-toplevel')) return out('/r\n')

    return out('', 1)
  })
  on('fs.read', async (_$, e) =>
    e.path === '/r/docs/backlog/BOARD.md' && board !== null ? { value: board } : { deny: 'ENOENT' },
  )
}
// Signals instead of sleeps: a counter of completed writes to the PBI state, and a wait for the Nth call to a hook.
const counter = (): { hit: () => void; until: (n: number) => Promise<void> } => {
  let count = 0
  const waiters: Array<[number, () => void]> = []

  return {
    hit: () => {
      count += 1
      for (const [n, resolve] of waiters) if (count >= n) resolve()
    },
    until: n => (count >= n ? Promise.resolve() : new Promise<void>(resolve => waiters.push([n, resolve]))),
  }
}
const watchPbiWrites = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const writes = counter()
  on('state.set', async (_$, e, next) => {
    const out = await next(e)
    if (e.plugin === 'goal-pin' && e.key === 'pbi') writes.hit()

    return out
  })

  return writes
}
// Yields enough microtasks for the settled continuations of a refresh that writes nothing to run before asserting.
const drain = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
const START = { cwd: '/r', surface: 'terminal', isInteractive: true } as never
const BOARD = '| PBI-016 | goal-pin falls back to the session\'s PBI | Doing |\n'

test('no goal: the branch PBI is shown', async ($, on) => {
  branchWorld(on, 'pbi/016-goal-pin-falls-back', BOARD)
  const writes = watchPbiWrites(on)
  await $.session.start(START)
  await writes.until(1)
  const ui = await $.ui.mount({ ...BAND })

  expect(await ui.find({ text: /PBI-016 · goal-pin falls back to the session's PBI/ })).toBeDefined()
})

test('no board row: the branch slug stands in for the title', async ($, on) => {
  branchWorld(on, 'pbi-016-goal-pin-falls-back', null)
  const writes = watchPbiWrites(on)
  await $.session.start(START)
  await writes.until(1)
  const ui = await $.ui.mount({ ...BAND })

  expect(await ui.find({ text: /PBI-016 · goal pin falls back/ })).toBeDefined()
})

test('a goal wins over the PBI', async ($, on) => {
  branchWorld(on, 'pbi/016-x', BOARD)
  const writes = watchPbiWrites(on)
  await $.session.start(START)
  await writes.until(1)
  await $.command.run({ command: 'goal', args: 'Ship the dashboard' } as never)
  const ui = await $.ui.mount({ ...BAND })

  expect(await ui.find({ text: /Ship the dashboard/ })).toBeDefined()
  expect(await ui.find({ text: /PBI-016/ })).toBeUndefined()
})

test('nothing on a non-PBI branch', async ($, on) => {
  branchWorld(on, 'main', BOARD)
  const writes = watchPbiWrites(on)
  await $.session.start(START)
  await writes.until(1)
  const ui = await $.ui.mount({ ...BAND })

  expect(await ui.find({ text: /◎/ })).toBeUndefined()
})

test('/goal clear suppresses the PBI fallback, and so does its button', async ($, on) => {
  branchWorld(on, 'pbi/016-x', BOARD)
  const writes = watchPbiWrites(on)
  await $.session.start(START)
  await writes.until(1)
  await $.command.run({ command: 'goal', args: 'clear' } as never)
  const ui = await $.ui.mount({ ...BAND })

  expect(await ui.find({ text: /PBI-016/ })).toBeUndefined()
})

test('the clear button hides a shown fallback', async ($, on) => {
  branchWorld(on, 'pbi/016-x', BOARD)
  const writes = watchPbiWrites(on)
  await $.session.start(START)
  await writes.until(1)
  const ui = await $.ui.mount({ ...BAND })
  expect(await ui.find({ text: /PBI-016/ })).toBeDefined()

  await ui.press({ key: 'clear' })
  expect(await ui.find({ text: /PBI-016/ })).toBeUndefined()
})

test('session.start does not wait for the refresh, and the band shows the PBI once it lands', async ($, on) => {
  world(on)
  on('session.start', async () => ({ cwd: '/r' }))
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  on('process.run', async (_$, e) => {
    await gate
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isTruncated: false } })

    return out(e.argv.includes('--abbrev-ref') ? 'pbi/016-slow\n' : '/r\n')
  })
  on('fs.read', async () => ({ deny: 'ENOENT' }))

  const writes = watchPbiWrites(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND })
  expect(await ui.find({ text: /PBI-016/ })).toBeUndefined()

  release()
  await writes.until(1)
  expect(await ui.find({ text: /PBI-016 · slow/ })).toBeDefined()
})

test('a slow older refresh does not overwrite a newer one', async ($, on) => {
  world(on)
  on('session.start', async () => ({ cwd: '/r' }))
  on('turn.complete', async () => ({ text: 'ok' }))
  const writes = watchPbiWrites(on)
  const started = counter()
  const boardReads = counter()
  const releases: Array<() => void> = []
  const branches = ['pbi/001-old', 'pbi/002-new']
  let n = 0
  on('process.run', async (_$, e) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isTruncated: false } })
    if (!e.argv.includes('--abbrev-ref')) return out('/r\n')
    const mine = n++
    const held = new Promise<void>(resolve => releases.push(resolve))
    started.hit()
    await held

    return out(`${branches[mine]}\n`)
  })
  on('fs.read', async (_$, e) => {
    if (e.path === '/r/docs/backlog/BOARD.md') boardReads.hit()

    return { deny: 'ENOENT' }
  })

  await $.session.start(START)
  await started.until(1)
  await $.turn.complete({ reason: 'answer', answer: 'ok' } as never)
  await started.until(2)
  releases[1]!()
  await writes.until(1)
  releases[0]!()
  await boardReads.until(2)
  await drain()

  const ui = await $.ui.mount({ ...BAND })
  expect(await ui.find({ text: /PBI-002 · new/ })).toBeDefined()
  expect(await ui.find({ text: /PBI-001/ })).toBeUndefined()
})

// Process and file answers the test can change between refreshes.
const liveWorld = (
  on: Parameters<Parameters<typeof test>[1]>[1],
  state: { branch: string | null; files: Record<string, string>; asked: string[] },
  headReads: { hit: () => void } = { hit: () => {} },
): void => {
  world(on)
  on('session.start', async () => ({ cwd: '/r' }))
  on('turn.complete', async () => ({ text: 'ok' }))
  on('process.run', async (_$, e) => {
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isTruncated: false } })
    if (e.argv.includes('--abbrev-ref')) {
      headReads.hit()

      return state.branch === null ? out('', 128) : out(`${state.branch}\n`)
    }

    return out('/r\n')
  })
  on('fs.read', async (_$, e) => {
    state.asked.push(e.path)

    return e.path in state.files ? { value: state.files[e.path]! } : { deny: 'ENOENT' }
  })
}

test('the local config board path beats the shared config, which beats the default', async ($, on) => {
  const state = {
    branch: 'pbi/016-x' as string | null,
    files: {
      '/r/backlog-delivery.config': 'board_path = "shared/BOARD.md"\n',
      '/r/backlog-delivery.local.config': 'board_path = "local/BOARD.md"\n',
      '/r/local/BOARD.md': '| PBI-016 | From local | Doing |\n',
      '/r/shared/BOARD.md': '| PBI-016 | From shared | Doing |\n',
      '/r/docs/backlog/BOARD.md': '| PBI-016 | From default | Doing |\n',
    } as Record<string, string>,
    asked: [] as string[],
  }
  liveWorld(on, state)
  const writes = watchPbiWrites(on)
  await $.session.start(START)
  await writes.until(1)
  const ui = await $.ui.mount({ ...BAND })

  expect(await ui.find({ text: /PBI-016 · From local/ })).toBeDefined()
  expect(state.asked).not.toContain('/r/shared/BOARD.md')
  expect(state.asked).not.toContain('/r/docs/backlog/BOARD.md')
})

test('the shared config board path is used when there is no local config', async ($, on) => {
  const state = {
    branch: 'pbi/016-x' as string | null,
    files: {
      '/r/backlog-delivery.config': 'board_path = "shared/BOARD.md"\n',
      '/r/shared/BOARD.md': '| PBI-016 | From shared | Doing |\n',
      '/r/docs/backlog/BOARD.md': '| PBI-016 | From default | Doing |\n',
    } as Record<string, string>,
    asked: [] as string[],
  }
  liveWorld(on, state)
  const writes = watchPbiWrites(on)
  await $.session.start(START)
  await writes.until(1)
  const ui = await $.ui.mount({ ...BAND })

  expect(await ui.find({ text: /PBI-016 · From shared/ })).toBeDefined()
  expect(state.asked).not.toContain('/r/docs/backlog/BOARD.md')
})

test('a failing git leaves the previous PBI shown and does not throw', async ($, on) => {
  const state = {
    branch: 'pbi/016-x' as string | null,
    files: { '/r/docs/backlog/BOARD.md': BOARD } as Record<string, string>,
    asked: [] as string[],
  }
  const headReads = counter()
  liveWorld(on, state, headReads)
  const writes = watchPbiWrites(on)
  await $.session.start(START)
  await writes.until(1)
  const ui = await $.ui.mount({ ...BAND })
  expect(await ui.find({ text: /PBI-016/ })).toBeDefined()

  state.branch = null
  await $.turn.complete({ reason: 'answer', answer: 'ok' } as never)
  await headReads.until(2)
  await drain()

  expect(await ui.find({ text: /PBI-016/ })).toBeDefined()
})

test('switching to a non-PBI branch clears the fallback on the next refresh', async ($, on) => {
  const state = {
    branch: 'pbi/016-x' as string | null,
    files: { '/r/docs/backlog/BOARD.md': BOARD } as Record<string, string>,
    asked: [] as string[],
  }
  liveWorld(on, state)
  const writes = watchPbiWrites(on)
  await $.session.start(START)
  await writes.until(1)
  const ui = await $.ui.mount({ ...BAND })
  expect(await ui.find({ text: /PBI-016/ })).toBeDefined()

  state.branch = 'main'
  await $.turn.complete({ reason: 'answer', answer: 'ok' } as never)
  await writes.until(2)

  expect(await ui.find({ text: /PBI-016/ })).toBeUndefined()
})

test('a first-prompt goal wins over a PBI that lands later', async ($, on) => {
  world(on)
  on('session.start', async () => ({ cwd: '/r' }))
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  on('process.run', async (_$, e) => {
    await gate
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isTruncated: false } })

    return out(e.argv.includes('--abbrev-ref') ? 'pbi/016-late\n' : '/r\n')
  })
  on('fs.read', async () => ({ deny: 'ENOENT' }))

  const writes = watchPbiWrites(on)
  await $.session.start(START)
  await $.prompt.submit({ text: 'Add a PBI summary to the dashboard' } as never)
  release()
  await writes.until(1)
  const ui = await $.ui.mount({ ...BAND })

  expect(await ui.find({ text: /Add a PBI summary to the dashboard/ })).toBeDefined()
  expect(await ui.find({ text: /PBI-016/ })).toBeUndefined()
})
