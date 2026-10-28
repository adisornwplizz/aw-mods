import { expect, test } from 'claude-code/testing'

const BRAND = '#CE6535'
const BRAND_LIGHT = '#E9A27F'
const BRAND_DEEP = '#9E4422'
const FAINT = '#A8ADB4'

const PANE = {
  plugin: 'context-tree',
  component: 'Pane',
  requestId: 'context-tree',
  props: {
    title: 'Context tree',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const FILES: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  '/p': [
    { name: 'README.md', kind: 'file' },
    { name: 'src', kind: 'dir' },
    { name: 'node_modules', kind: 'dir' },
    { name: 'dist', kind: 'dir' },
  ],
  '/p/src': [
    { name: 'a.ts', kind: 'file' },
    { name: 'b.ts', kind: 'file' },
    { name: 'c.ts', kind: 'file' },
  ],
}

const NOT_REPO = { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false }

let cwdNow = '/p'
const ticks: (() => void)[] = []

const engine = (on: Parameters<Parameters<typeof test>[1]>[1], git: 'repo' | 'none' | 'nested' = 'repo') => {
  on('command.register', () => ({ value: { command: 'context-tree' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  cwdNow = '/p'
  ticks.length = 0
  on('session.cwd', () => ({ value: cwdNow }))
  on('clock.every', () => new Promise(resolve => ticks.push(() => resolve({ value: undefined }))))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('clock.after', () => ({ value: undefined }))
  on('fs.list', (_, e) => ({
    value: (FILES[e.path] ?? []).map(f => ({ ...f, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.stat', (_, e) => ({
    value: { kind: e.path.endsWith('.ts') || e.path.endsWith('.md') ? 'file' : 'dir', size: 1, mtimeMs: 0 },
  }))
  on('process.run', (_, e) => ({
    value:
      git === 'none'
        ? NOT_REPO
        : git === 'nested'
          ? e.init?.cwd !== '/p/src'
            ? NOT_REPO
            : e.argv[1] === 'rev-parse'
              ? { exitCode: 0, stdout: '/p/src\n', stderr: '', isStdoutTruncated: false }
              : { exitCode: 0, stdout: '## feat/w1-xero-connects-and-more...origin/feat [ahead 2]\0 M b.ts\0', stderr: '', isStdoutTruncated: false }
          : e.argv[1] === 'rev-parse'
          ? { exitCode: 0, stdout: '/p\n', stderr: '', isStdoutTruncated: false }
          : { exitCode: 0, stdout: '## main...origin/main [ahead 1]\0 M src/b.ts\0?? src/c.ts\0!! dist/\0', stderr: '', isStdoutTruncated: false },
  }))
  on('tool.call', (_, e) => ({ result: {}, text: e.tool === 'Read' || e.tool === 'Bash' ? 'x'.repeat(4000) : 'ok' }))
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`touched files take the brand colors, folders open to them, untouched stay faint, on ${surface}`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/p', surface, isInteractive: true })
    await $.tool.call({ tool: 'Read', file_path: '/p/src/a.ts' })
    await $.tool.call({ tool: 'Edit', file_path: '/p/src/b.ts', old_string: 'a', new_string: 'b', replace_all: false })

    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /touched ·/ }))?.text).toBe('2 touched · ~1k tokens')
    expect((await ui.find({ type: 'Text', text: 'p' }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^● dist\/$/ }))?.props.color).toBe('#D3D6DA')
    expect((await ui.find({ type: 'Text', text: /±/ }))?.text).toBe('~1k ±2')
    expect(await ui.find({ type: 'Text', text: /node_modules/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^● README\.md$/ }))?.props.color).toBe(FAINT)
    expect((await ui.find({ type: 'Text', text: /^● src\/$/ }))?.props.color).toBe(BRAND)
    expect((await ui.find({ type: 'Text', text: /^● a\.ts$/ }))?.props.color).toBe(BRAND_LIGHT)
    expect((await ui.find({ type: 'Text', text: /^● b\.ts$/ }))?.props.color).toBe(BRAND)
    expect((await ui.find({ type: 'Text', text: /^● c\.ts$/ }))?.props.color).toBe(FAINT)
    expect((await ui.find({ type: 'Text', text: /~1 M/ }))?.text).toBe('~1 M')
    expect((await ui.find({ type: 'Text', text: /^ U$/ }))?.text).toBe(' U')
    expect((await ui.find({ type: 'Text', text: /^⎇ main/ }))?.text).toBe('⎇ main · ↑1 · 2 changed')

    await ui.press({ key: '/p/src' })
    expect(await ui.find({ type: 'Text', text: /^● a\.ts$/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('with follow off, a folder stays closed until clicked', { options: { follow: 'off' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/p/src/a.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^● a\.ts$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^● src\/$/ }))?.props.color).toBe(BRAND_LIGHT)

  await ui.press({ key: '/p/src' })
  expect((await ui.find({ type: 'Text', text: /^● a\.ts$/ }))?.props.color).toBe(BRAND_LIGHT)
  await ui.unmount()
})

test('a workspace that is no repo shows the branch of each repo folder inside it', async ($, on) => {
  engine(on, 'nested')
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /inside ·/ }))?.text).toBe('⎇ 1 repo inside · 1 changed')
  expect((await ui.find({ type: 'Text', text: /^⎇ feat/ }))?.text).toBe('⎇ feat/w1-xero-connec… ↑2 ±1 ')
  await ui.unmount()
})

test('the tree follows the session from the desktop spare folder into the project', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/spare', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: 'spare' }))?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'Empty folder.' }))?.text).toBe('Empty folder.')

  ticks.shift()?.()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect((await ui.find({ type: 'Text', text: 'p' }))?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^● README\.md$/ }))?.props.color).toBe(FAINT)
  expect((await ui.find({ type: 'Text', text: /^⎇ main/ }))?.text).toBe('⎇ main · ↑1 · 2 changed')
  await ui.unmount()
})

test('outside a git repo there is no branch line', async ($, on) => {
  engine(on, 'none')
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /⎇/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^● README\.md$/ }))?.props.color).toBe(FAINT)
  await ui.unmount()
})

test('a fresh session says nothing is touched yet and shows no ranking', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /no files touched yet/ }))?.text).toBe('no files touched yet')
  expect(await ui.find({ type: 'Text', text: 'most context' })).toBeUndefined()
  await ui.unmount()
})

test('the most-context list ranks files with a dot bar, and @ attaches a file to the prompt', async ($, on) => {
  engine(on)
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/p/src/b.ts', old_string: 'a', new_string: 'b', replace_all: false })
  await $.tool.call({ tool: 'Read', file_path: '/p/src/a.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: 'most context' }))?.text).toBe('most context')
  const dots = await ui.findAll({ type: 'Text', text: /^●+$/ })
  expect(dots.filter(t => t.props.color === BRAND).map(t => t.text)).toEqual(['●●●●●●●●', '●'])
  expect(dots.filter(t => t.props.color === '#E8EAED').map(t => t.text)).toEqual(['●●●●●●●'])

  await ui.press({ key: '/p/src/a.ts' })
  expect(filled).toEqual(['@src/a.ts '])
  await ui.unmount()
})

test('a Bash reader counts as a read, and the touched view ranks files by tokens', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/p/src/b.ts', old_string: 'a', new_string: 'b', replace_all: false })
  await $.tool.call({ tool: 'Read', file_path: '/p/src/a.ts' })
  await $.tool.call({ tool: 'Bash', command: "sed -n '1,5p' src/a.ts | head" })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'view-touched' })

  const rows = await ui.findAll({ type: 'Text', text: /^● src\// })
  expect(rows.map(r => r.text)).toEqual(['● src/a.ts ×2', '● src/b.ts'])
  expect(await ui.find({ type: 'Text', text: 'most context' })).toBeUndefined()
  await ui.unmount()
})

test('a subagent read flashes the file without adding tokens', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/p/README.md', agentId: 'a1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /1 touched · ~0 tokens/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^● README\.md$/ }))?.props.color).toBe(BRAND_DEEP)
  await ui.unmount()
})
