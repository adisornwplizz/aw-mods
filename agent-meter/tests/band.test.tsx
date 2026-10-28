import { expect, test } from 'claude-code/testing'

const BAND = { plugin: 'agent-meter', component: 'AbovePrompt', props: { hasSurvey: false } } as const
const NOW = 1_800_000_000_000

const LIMITS = [
  { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(NOW + 72 * 60_000).toISOString() },
  { kind: 'seven_day', percentUsed: 85 },
]

const measure = (tokens: number) => ({
  context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) },
  rateLimits: LIMITS,
  cost: { usd: 1.234 },
  changed: ['context' as const],
})

const engine = (on: Parameters<Parameters<typeof test>[1]>[1], turns = 7) => {
  const spawned: { id: string; type: string; description: string; status: 'running' }[] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'agent-meter' } }))
  on('session.usage', () => ({
    value: { startedAt: NOW - 2 * 3_600_000, context: { tokens: 84_000, window: 1_000_000, percent: 8 }, rateLimits: LIMITS, cost: { usd: 1.234 } },
  }))
  on('session.turns', () => ({ value: turns }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('agent.list', () => ({ value: spawned }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: 'x'.repeat(150_000) }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('agent.spawn', (_, e) => {
    spawned.push({ id: 'a1', type: e.subagentType, description: e.description, status: 'running' })
    return { model: 'claude-opus-5-5', agentId: 'a1' }
  })
  return { toasts }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band shows context, growth, age, cost and agents on ${surface}`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.session.measure(measure(84_000))
    await $.tool.call({ tool: 'Read', file_path: '/src/invoice.ts' })
    await $.session.measure(measure(122_000))
    await $.agent.spawn({ prompt: 'find the auth code', description: 'find auth code', subagentType: 'Explore' })

    const ui = await $.ui.mount({ ...BAND, surface })
    const text = async (pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern }))?.text

    expect(await text(/of 1\.0M$/)).toBe(`${'●'.repeat(12)} 12% of 1.0M`)
    expect(await text(/\/msg/)).toBe('122k/msg · Δ +38k Read invoice.ts')
    expect(await text(/prompts/)).toBe('2h00m · 7 prompts · $1.23')
    expect(await text(/ run/)).toBe('1 run · 0 done')
    expect(await text(/^5h /)).toBe('5h 42% ↺1h12m · 7d 85% · cache --')

    if (surface === 'terminal') {
      expect(await text(/context after each prompt/)).toBe('context after each prompt · last 24 → now')
      expect(await text(/≥500k$/)).toBe(`${'●'.repeat(24)} ≥500k`)
      expect(await text(/^●{24}$/)).toBe('●'.repeat(24))
    } else {
      const source = String((await ui.find({ type: 'Svg' }))?.props.source)
      expect(source).toContain('context after each prompt · last 24 → now')
      expect(source.match(/<circle /g)).toHaveLength(48)
      expect(source.match(/fill="#CE6535"/g)).toHaveLength(3)
      expect(source).toContain('stroke-dasharray')
      expect(source).toContain('>500k</text>')
    }
    const agent = (await ui.find({ type: 'Text', text: /Explore/ }))?.text
    expect(agent).toContain('└─')
    expect(agent).toContain('[opus-5-5] find auth code')
    await ui.unmount()
  })
}

test('each threshold raises one toast, and a compaction re-arms it', async ($, on) => {
  const { toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.session.measure(measure(450_000))
  await $.session.measure(measure(510_000))
  await $.session.measure(measure(560_000))
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('510k ≥ 500k')

  await $.session.measure(measure(820_000))
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toContain('≥ 800k')

  await $.session.measure(measure(90_000))
  await $.session.measure(measure(530_000))
  expect(toasts.length).toBe(3)
})

test('thresholds come from the plugin options', { options: { warnTokens: 50_000, alertTokens: 100_000 } }, async ($, on) => {
  const { toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(120_000))
  expect(toasts[0]).toContain('≥ 100k')
})

test('the chart starts from the context at load', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const chartRows = await ui.findAll({ type: 'Text', text: /^●{24}/ })
  const orange = chartRows.flatMap(row => row.children).filter(dot => typeof dot === 'object' && dot.props.color === '#CE6535')
  expect(orange).toHaveLength(1)
  await ui.unmount()
})

test('the cache hit of the latest main-thread request', async ($, on) => {
  engine(on)
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 2_000, output_tokens: 10, cache_read_input_tokens: 98_000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
    }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5' })) {
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^5h / }))?.text).toContain('cache 98%')
  await ui.unmount()
})

test('a meter saved by the previous version still draws', async ($, on) => {
  engine(on)
  on('state.get', (_, e, next) =>
    e.key === 'meter'
      ? { value: { value: { contextTokens: 173_000, window: 1_000_000, percent: 17, usd: 4.95, startedAt: NOW - 3_600_000, turns: 19 }, version: 1 } }
      : next(e),
  )

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /\/msg/ }))?.text).toBe('173k/msg · Δ --')
  expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toBe('cache --')
  await ui.unmount()
})

test('a /model switch changes the window within one poll', async ($, on) => {
  let window = 1_000_000
  const ticks: (() => void)[] = []
  on('command.register', () => ({ value: { command: 'agent-meter' } }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: 150_000, window, percent: Math.round((150_000 / window) * 100) }, rateLimits: [], cost: { usd: 1 } },
  }))
  on('session.turns', () => ({ value: 1 }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => new Promise(resolve => ticks.push(() => resolve({ value: undefined }))))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /of / }))?.text).toContain(' 15% of 1.0M')

  window = 200_000
  ticks.shift()?.()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect((await ui.find({ type: 'Text', text: /of / }))?.text).toContain(' 75% of 200k')
  await ui.unmount()
})

test('a long Bash command is labelled by its program, and one prompt is singular', async ($, on) => {
  engine(on, 1)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure(100_000))
  await $.tool.call({ tool: 'Bash', command: "sed -n '40,90p' docs/notes.md" })
  await $.session.measure(measure(105_000))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /\/msg/ }))?.text).toBe('105k/msg · Δ +5k Bash sed')
  expect((await ui.find({ type: 'Text', text: /prompt/ }))?.text).toContain('· 1 prompt ·')
  for (const line of [/^●/, /\/msg/, /prompt/, / run/]) {
    expect((await ui.find({ type: 'Text', text: line }))?.props.wrap).toBe('truncate-end')
  }
  await ui.unmount()
})

test('/agent-meter hides the band', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'agent-meter', args: '' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band still draws past the alert line on ${surface}`, async ($, on) => {
    const { toasts } = engine(on, 140)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    for (let i = 0; i < 30; i++) await $.session.measure(measure(450_000 + i * 15_000))
    expect(toasts.length).toBe(2)

    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /\/msg/ }))?.text).toContain('885k/msg')
    await ui.unmount()
  })
}
