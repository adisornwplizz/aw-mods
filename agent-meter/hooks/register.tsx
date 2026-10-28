import { atom, read, update } from 'claude-code'
import type { AgentInfo, Register, SessionContextUsage, SessionCost, SessionRateLimit, TurnUsage } from 'claude-code'

import type { AgentRow, Growth, Level, Limit, Meter } from '../types'

const meter = atom({ plugin: 'agent-meter', key: 'meter' } as const, null)
const history = atom({ plugin: 'agent-meter', key: 'history' } as const, [] as number[])
const growth = atom({ plugin: 'agent-meter', key: 'growth' } as const, null)
const cacheHit = atom({ plugin: 'agent-meter', key: 'cacheHit' } as const, null)
const warned = atom({ plugin: 'agent-meter', key: 'warned' } as const, 'ok' as Level)
const agents = atom({ plugin: 'agent-meter', key: 'agents' } as const, [] as AgentRow[])
const now = atom({ plugin: 'agent-meter', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'agent-meter', key: 'isHidden' } as const, false)

const ACTIVE = new Set(['pending', 'running', 'waiting'])
const BRAND = '#CE6535'
const BRAND_DEEP = '#9E4422'
const EMPTY = '#E8EAED'
const DOT = '●'
const BAR_DOTS = 12
const GRID_COLS = 24
const SVG = { col: 13, row: 20, radius: 4.5, left: 2, plotTop: 20, font: 13, width: 2 + 24 * 13 + 40, height: 20 + 2 * 20, ink: '#8E8E93' }
const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const RANK: Record<Level, number> = { ok: 0, warn: 1, alert: 2 }
const COLOR: Record<Level, string> = { ok: BRAND, warn: 'warning', alert: 'error' }
const BIG_GROWTH = 20_000

const toLimit = (limit: SessionRateLimit): Limit => ({
  kind: LIMIT_NAMES[limit.kind] ?? limit.kind,
  percent: limit.percentUsed,
  resetsAt: limit.resetsAt ? Date.parse(limit.resetsAt) : null,
})

const toMeter = (
  context: SessionContextUsage,
  cost: SessionCost | undefined,
  limits: SessionRateLimit[],
  startedAt: number,
  turns: number,
): Meter => ({
  contextTokens: context.tokens ?? null,
  window: context.window,
  percent: context.percent ?? null,
  usd: cost?.usd ?? null,
  startedAt,
  turns,
  limits: limits.map(toLimit),
})

const levelOf = (tokens: number, warnAt: number, alertAt: number): Level =>
  tokens >= alertAt ? 'alert' : tokens >= warnAt ? 'warn' : 'ok'

const contextOf = (u: TurnUsage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

const compact = (n: number) => {
  const abs = Math.abs(n)
  return abs >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : abs >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
}

const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const [d, h, m] = [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60]
  const pad = (n: number) => String(n).padStart(2, '0')
  return d > 0 ? `${d}d${pad(h)}h` : h > 0 ? `${h}h${pad(m)}m` : m > 0 ? `${m}m${pad(s % 60)}s` : `${s}s`
}

const filledDots = (percent: number) => Math.round((Math.min(100, percent) / 100) * BAR_DOTS)

// One column per prompt, oldest left: the bottom dot is on once the prompt has a reading, the top dot once its context passed the warn line.
const grid = (points: number[], warnAt: number) => {
  const padded = [...Array<number | null>(GRID_COLS - points.length).fill(null), ...points]
  return [
    { cells: padded.map(p => p !== null && p >= warnAt), isPastWarn: true },
    { cells: padded.map(p => p !== null), isPastWarn: false },
  ]
}

// The Desktop chart: title, four rows of round dots, and a dashed warn line, sized to four lines of body text.
const chartSvg = (points: number[], warnAt: number) => {
  const rows = grid(points, warnAt)
  const plotRight = SVG.left + GRID_COLS * SVG.col
  const rowY = (r: number) => SVG.plotTop + SVG.row / 2 + r * SVG.row
  const dots = rows.flatMap((row, r) =>
    row.cells.map((isOn, c) => {
      const fill = isOn ? (row.isPastWarn ? BRAND_DEEP : BRAND) : EMPTY
      return `<circle cx="${SVG.left + SVG.col / 2 + c * SVG.col}" cy="${rowY(r)}" r="${SVG.radius}" fill="${fill}"/>`
    }),
  )
  const label = (text: string, y: number) =>
    `<text x="${plotRight + 6}" y="${y}" dominant-baseline="middle" font-size="${SVG.font - 1}" fill="${SVG.ink}">${text}</text>`
  const warnY = SVG.plotTop + SVG.row
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG.width}" height="${SVG.height}" viewBox="0 0 ${SVG.width} ${SVG.height}" font-family="-apple-system, system-ui, sans-serif">`,
    `<text x="${SVG.left}" y="${SVG.font}" font-size="${SVG.font}" fill="${SVG.ink}">context after each prompt · last ${GRID_COLS} → now</text>`,
    ...dots,
    `<line x1="${SVG.left}" x2="${plotRight}" y1="${warnY}" y2="${warnY}" stroke="${BRAND_DEEP}" stroke-width="1" stroke-dasharray="3 3"/>`,
    label(compact(warnAt), warnY),
    '</svg>',
  ].join('')
}

const shortModel = (id: string) => id.replace(/^claude-/, '').replace(/-\d{8}$/, '')

const basename = (path: string) => path.split('/').pop() ?? path

const merge = (rows: AgentRow[], listed: AgentInfo[], at: number): AgentRow[] =>
  listed.map(info => {
    const known = rows.find(row => row.id === info.id)
    return {
      id: info.id,
      type: info.type,
      description: info.description,
      status: info.status,
      firstSeenAt: known?.firstSeenAt ?? at,
      outputTokens: known?.outputTokens ?? 0,
      contextTokens: known?.contextTokens ?? 0,
      model: known?.model ?? null,
    }
  })

const isSameRoster = (a: AgentRow[], b: AgentRow[]) =>
  a.length === b.length && a.every((row, i) => row.id === b[i]?.id && row.status === b[i]?.status)

export const register: Register = (on, options) => {
  const warnAt = Number(options.warnTokens ?? 500_000)
  const alertAt = Number(options.alertTokens ?? 800_000)
  let biggest: { chars: number; label: string | null } = { chars: 0, label: null }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-meter',
      description: 'Show or hide the token and agent band above the prompt',
    })
    const usage = await $.session.usage()
    const turns = await $.session.turns()
    await update($, meter, () => toMeter(usage.context, usage.cost, usage.rateLimits, usage.startedAt, turns))
    const seed = usage.context.tokens
    if (seed !== undefined) {
      await update($, history, points => (points.length > 0 ? points : [seed]))
    }

    $.clock.every(1000, async () => {
      const at = await $.clock.now()
      const listed = await $.agent.list()
      const rows = await read($, agents)
      const roster = merge(rows, listed, at)
      if (!isSameRoster(rows, roster)) {
        await update($, agents, latest => merge(latest, listed, at))
      }
      if (roster.some(row => ACTIVE.has(row.status))) {
        await update($, now, () => at)
      }
      // No event announces a /model switch, so the window is re-read here rather than waiting for the next reply.
      const { context } = await $.session.usage()
      const shown = await read($, meter)
      if (shown && shown.window !== context.window) {
        await update($, meter, was => was && { ...was, window: context.window, percent: context.percent ?? null })
      }
    })

    return next(e)
  })

  on('command.run', { command: 'agent-meter' }, async $ => {
    const hidden = await update($, isHidden, was => !was)
    return { text: hidden ? 'Agent meter hidden.' : 'Agent meter shown.' }
  })

  // Remembers the main loop's largest tool result, so the next measure can name what grew the context.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const size = ran.text?.length ?? 0
    if (!e.agentId && size > biggest.chars) {
      const label =
        e.tool === 'Read'
          ? `Read ${basename(e.file_path)}`
          : e.tool === 'Bash'
            ? `Bash ${e.command.trim().split(/\s+/)[0]}`
            : (e.tool.split('__').pop() ?? e.tool)
      biggest = { chars: size, label }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const prev = await read($, meter)
    const turns = await $.session.turns()
    const m = toMeter(e.context, e.cost, e.rateLimits, prev?.startedAt ?? 0, turns)
    await update($, meter, () => m)

    const tokens = m.contextTokens
    if (tokens !== null && e.changed.includes('context')) {
      await update($, history, points => [...points, tokens].slice(-GRID_COLS))
      if (prev?.contextTokens != null) {
        const grown: Growth = { tokens: tokens - prev.contextTokens, label: biggest.label }
        await update($, growth, () => grown)
      }
      biggest = { chars: 0, label: null }

      const level = levelOf(tokens, warnAt, alertAt)
      const before = await read($, warned)
      if (RANK[level] > RANK[before]) {
        const limit = level === 'alert' ? alertAt : warnAt
        $.ui.toast(`context ${compact(tokens)} ≥ ${compact(limit)}: each message now re-reads it. /compact or start a fresh session.`)
      }
      if (level !== before) {
        await update($, warned, () => level)
      }
    }

    return next(e)
  })

  // A meter failure must never fail the spawn it observed.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId
    if (id) {
      const at = await $.clock.now()
      const row: AgentRow = {
        id,
        type: e.subagentType,
        description: e.description,
        status: 'running',
        firstSeenAt: at,
        outputTokens: 0,
        contextTokens: 0,
        model: started.model,
      }
      await update($, agents, rows =>
        rows.some(r => r.id === id)
          ? rows.map(r => (r.id === id ? { ...r, model: r.model ?? started.model } : r))
          : [...rows, row],
      )
      await update($, now, () => at)
    }
    return started
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (usage && !e.agentId) {
      const read = usage.cache_read_input_tokens
      await update($, cacheHit, () => Math.round((read / Math.max(1, contextOf(usage))) * 100))
    }
    if (usage && e.agentId) {
      await update($, agents, rows =>
        rows.map(row =>
          row.id === e.agentId
            ? { ...row, outputTokens: row.outputTokens + usage.output_tokens, contextTokens: contextOf(usage), model: usage.model }
            : row,
        ),
      )
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const stored = await read($, meter)
    if (e.props.hasSurvey || stored === null || (await read($, isHidden))) {
      return next(e)
    }
    // A meter saved by an earlier version outlives a reload and may lack fields added since.
    const m: Meter = { ...stored, limits: stored.limits ?? [] }

    const { Box, Text } = $.ui.resolve(e)
    const rows = await read($, agents)
    const points = await read($, history)
    const grown = await read($, growth)
    const at = await read($, now)
    const clock = await $.clock.now()
    const running = rows.filter(row => ACTIVE.has(row.status))
    const done = rows.length - running.length
    const tokens = m.contextTokens ?? 0
    const level = levelOf(tokens, warnAt, alertAt)
    const filled = filledDots(m.percent ?? 0)
    const frame = SPINNER[Math.floor(at / 1000) % SPINNER.length]
    const latest = points[points.length - 1] ?? tokens
    const hit = await read($, cacheHit)
    const sep = <Text dimColor> · </Text>
    const info = (
      <Text tabular>
        {m.limits.map((limit, i) => (
          <Text key={limit.kind}>
            {i > 0 ? sep : null}
            <Text dimColor>{limit.kind} </Text>
            <Text color={limit.percent >= 95 ? 'error' : limit.percent >= 80 ? 'warning' : undefined}>
              {Math.round(limit.percent)}%
            </Text>
            {limit.resetsAt === null ? null : <Text dimColor> ↺{duration(limit.resetsAt - clock)}</Text>}
          </Text>
        ))}
        {m.limits.length > 0 ? sep : null}
        <Text dimColor>cache </Text>
        <Text color={hit !== null && hit < 80 ? 'warning' : undefined}>{hit === null ? '--' : `${hit}%`}</Text>
      </Text>
    )

    const surface = e.surface
    let chart
    if (surface === 'terminal') {
      chart = (
        <Box flexDirection="column">
          <Text dimColor>context after each prompt · last {GRID_COLS} → now</Text>
          {grid(points, warnAt).map((row, r) => (
            <Text key={`g${r}`}>
              {row.cells.map((isOn, c) => (
                <Text key={`c${c}`} color={isOn ? (row.isPastWarn ? BRAND_DEEP : BRAND) : EMPTY}>{DOT}</Text>
              ))}
              <Text dimColor>{r === 0 ? ` ≥${compact(warnAt)}` : ''}</Text>
            </Text>
          ))}
        </Box>
      )
    } else {
      const { Svg } = $.ui.resolve({ ...e, surface })
      chart = (
        <Svg
          source={chartSvg(points, warnAt)}
          alt={`Context after each of the last ${GRID_COLS} prompts, latest ${compact(latest)}`}
          width={SVG.width}
          height={SVG.height}
        />
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center" gap={3}>
          <Box flexDirection="column" flexShrink={0}>
            {chart}
            {info}
          </Box>
          <Box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
            <Box flexDirection="column">
              <Text dimColor>ctx</Text>
              <Text dimColor>↻</Text>
              <Text dimColor>⏱</Text>
              <Text dimColor>⚙</Text>
            </Box>
            <Box flexDirection="column" flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end" tabular>
                <Text color={COLOR[level]}>{DOT.repeat(filled)}</Text>
                <Text color={EMPTY}>{DOT.repeat(BAR_DOTS - filled)}</Text>
                <Text> {m.percent === null ? '--' : `${m.percent}%`}</Text>
                <Text dimColor> of {compact(m.window)}</Text>
              </Text>
              <Text wrap="truncate-end" tabular>
                <Text color={COLOR[level]} weight="semibold">{compact(tokens)}</Text>
                <Text dimColor>/msg</Text>
                {sep}
                <Text dimColor>Δ </Text>
                {grown ? (
                  <Text>
                    <Text color={grown.tokens >= BIG_GROWTH ? BRAND : undefined}>
                      {grown.tokens >= 0 ? '+' : ''}
                      {compact(grown.tokens)}
                    </Text>
                    {grown.label && grown.tokens > 0 ? <Text dimColor> {grown.label}</Text> : null}
                  </Text>
                ) : (
                  <Text dimColor>--</Text>
                )}
              </Text>
              <Text wrap="truncate-end" tabular>
                <Text>{m.startedAt > 0 ? duration(clock - m.startedAt) : '--'}</Text>
                {sep}
                <Text dimColor>
                  {m.turns} {m.turns === 1 ? 'prompt' : 'prompts'}
                </Text>
                {m.usd === null ? null : (
                  <Text>
                    {sep}${m.usd.toFixed(2)}
                  </Text>
                )}
              </Text>
              <Text wrap="truncate-end" tabular>
                <Text color={running.length > 0 ? BRAND : undefined}>{running.length} run</Text>
                <Text dimColor> · {done} done</Text>
              </Text>
            </Box>
          </Box>
        </Box>
        {running.map((row, i) => (
          <Text key={row.id}>
            <Text dimColor>{i === running.length - 1 ? '└─ ' : '├─ '}</Text>
            <Text color={BRAND}>{frame} </Text>
            <Text weight="semibold">{row.type}</Text>
            {row.model ? <Text color={BRAND}> [{shortModel(row.model)}]</Text> : null}
            <Text> {row.description}</Text>
            <Text dimColor>
              {' │ '}
              {compact(row.contextTokens)} ctx · {compact(row.outputTokens)} out · {duration(at - row.firstSeenAt)}
            </Text>
          </Text>
        ))}
      </Box>
    )
  })
}
