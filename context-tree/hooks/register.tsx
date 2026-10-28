import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Branch, Entry, Touch, View } from '../types'

const PANE = 'context-tree'
const TITLE = 'Context tree'
const BRAND = '#CE6535'
const BRAND_LIGHT = '#E9A27F'
const BRAND_DEEP = '#9E4422'
const FAINT = '#A8ADB4'
const IGNORED = '#D3D6DA'
const IGNORED_MARK = '!'
const EMPTY = '#E8EAED'
const BAR_DOTS = 8
const TOP_FILES = 5
const BRANCH_CHARS = 20
const DOT = '●'
const FLASH_MS = 2700
const CHARS_PER_TOKEN = 4
const SKIP = new Set(['.git', 'node_modules', '.DS_Store'])
const READERS = new Set(['cat', 'head', 'tail', 'sed', 'nl', 'less', 'bat', 'wc', 'awk'])

const root = atom({ plugin: 'context-tree', key: 'root' } as const, '')
const activity = atom({ plugin: 'context-tree', key: 'activity' } as const, {} as Record<string, Activity>)
const dirs = atom({ plugin: 'context-tree', key: 'dirs' } as const, {} as Record<string, Entry[]>)
const expanded = atom({ plugin: 'context-tree', key: 'expanded' } as const, [] as string[])
const git = atom({ plugin: 'context-tree', key: 'git' } as const, {} as Record<string, string>)
const repos = atom({ plugin: 'context-tree', key: 'repos' } as const, {} as Record<string, Branch>)
const flash = atom({ plugin: 'context-tree', key: 'flash' } as const, [] as string[])
const view = atom({ plugin: 'context-tree', key: 'view' } as const, 'tree' as View)

let follow = true

const join = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)
const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path
const dirname = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf('/')))
const inside = (base: string, path: string) => path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`)
const relative = (base: string, path: string) => (path === base ? '.' : path.slice(base.length + 1))

const normalize = (path: string) => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

const absolute = (cwd: string, path: string) => normalize(path.startsWith('/') ? path : join(cwd, path))
const estimate = (chars: number) => Math.round(chars / CHARS_PER_TOKEN)

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

// `## main...origin/main [ahead 1, behind 2]`, the first entry of `git status -b`.
const parseBranch = (header: string): Branch | null => {
  const m = /^## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(header)
  if (!m || !m[1]) return null
  const count = (word: string) => Number(new RegExp(`${word} (\\d+)`).exec(m[3] ?? '')?.[1] ?? 0)
  return { name: m[1] === 'HEAD (no branch)' ? 'detached' : m[1], upstream: m[2] ?? null, ahead: count('ahead'), behind: count('behind') }
}

const colorOf = (kind: Touch | undefined, isFlashing: boolean) =>
  isFlashing ? BRAND_DEEP : kind === 'write' ? BRAND : kind === 'read' ? BRAND_LIGHT : FAINT

async function loadDir($: EngineInterface, dir: string): Promise<void> {
  try {
    const listed = await $.fs.list(dir)
    const entries = await Promise.all(
      listed
        .filter(e => !SKIP.has(e.name))
        .map(async (e): Promise<Entry> => {
          if (e.kind !== 'other') return { name: e.name, isDir: e.kind === 'dir' }
          const target = await $.fs.stat(join(dir, e.name)).catch(() => null)
          return { name: e.name, isDir: target?.kind === 'dir' }
        }),
    )
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    await update($, dirs, cur => ({ ...cur, [dir]: entries }))
  } catch {
    await update($, dirs, cur => ({ ...cur, [dir]: [] }))
  }
}

async function reloadOpen($: EngineInterface): Promise<void> {
  const top = await read($, root)
  if (!top) return
  for (const dir of [top, ...(await read($, expanded))]) await loadDir($, dir)
}

type GitStatus = { base: string; branch: Branch | null; marks: Record<string, string> }

async function statusOf($: EngineInterface, dir: string): Promise<GitStatus | null> {
  const status = await $.process.run(['git', 'status', '--porcelain=v1', '-b', '-z', '--ignored'], { cwd: dir, timeoutMs: 5000 }).catch(() => null)
  if (!status || status.exitCode !== 0) return null
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 3000 }).catch(() => null)
  const base = top?.exitCode === 0 ? top.stdout.trim() : dir
  const parts = status.stdout.split('\0')
  const hasHeader = parts[0]?.startsWith('## ') ?? false
  const marks: Record<string, string> = {}
  for (let i = hasHeader ? 1 : 0; i < parts.length; i++) {
    const line = parts[i] ?? ''
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    marks[join(base, line.slice(3).replace(/\/$/, ''))] = xy === '??' ? 'U' : xy === '!!' ? IGNORED_MARK : (xy.trim()[0] ?? 'M')
    // A rename or copy is followed by its old path, which has no mark of its own.
    if (xy[0] === 'R' || xy[0] === 'C') i++
  }
  return { base, branch: hasHeader && parts[0] ? parseBranch(parts[0]) : null, marks }
}

// A workspace folder that is no repo itself often holds several (api/, web/, ...),
// so then each top-level folder with a .git of its own is read instead.
async function refreshGit($: EngineInterface): Promise<void> {
  const cwd = await read($, root)
  if (!cwd) return
  const found: GitStatus[] = []
  const own = await statusOf($, cwd)
  if (own) found.push(own)
  else
    for (const entry of (await read($, dirs))[cwd] ?? []) {
      const dir = join(cwd, entry.name)
      if (!entry.isDir || !(await $.fs.stat(join(dir, '.git')).catch(() => null))) continue
      const nested = await statusOf($, dir)
      if (nested) found.push(nested)
    }
  await update($, git, () => Object.assign({}, ...found.map(f => f.marks)))
  await update($, repos, () => Object.fromEntries(found.flatMap(f => (f.branch ? [[f.base, f.branch]] : []))))
}

async function touch($: EngineInterface, paths: string[], kind: Touch, tokens: number): Promise<void> {
  if (paths.length === 0) return
  const at = await $.clock.now()
  const share = Math.round(tokens / paths.length)
  await update($, activity, cur => {
    const out = { ...cur }
    for (const path of paths) {
      const was = out[path]
      out[path] = {
        kind: was?.kind === 'write' || kind === 'write' ? 'write' : 'read',
        tokens: (was?.tokens ?? 0) + share,
        count: (was?.count ?? 0) + 1,
        at,
      }
    }
    return out
  })
  await update($, flash, () => paths)
  if (follow) await reveal($, paths)
  $.clock.after(FLASH_MS, () => void update($, flash, cur => (cur.some(p => paths.includes(p)) ? [] : cur)))
}

async function reveal($: EngineInterface, paths: string[]): Promise<void> {
  const top = await read($, root)
  const open = new Set(await read($, expanded))
  const missing = new Set<string>()
  for (const path of paths)
    for (let dir = dirname(path); inside(top, dir) && dir !== top; dir = dirname(dir)) if (!open.has(dir)) missing.add(dir)
  if (missing.size === 0) return
  const loaded = await read($, dirs)
  for (const dir of [...missing].sort()) if (!loaded[dir]) await loadDir($, dir)
  await update($, expanded, cur => [...new Set([...cur, ...missing])])
}

async function wrote($: EngineInterface, path: string, tokens: number): Promise<void> {
  const file = normalize(path)
  await touch($, [file], 'write', tokens)
  void (async () => {
    if ((await read($, dirs))[dirname(file)]) await loadDir($, dirname(file))
    await refreshGit($)
  })().catch(() => undefined)
}

async function shell($: EngineInterface, command: string, tokens: number): Promise<void> {
  const words = (command.split(/&&|\|\||;|\|/)[0] ?? '').trim().split(/\s+/)
  const program = basename(words[0] ?? '')
  if (!READERS.has(program)) {
    void reloadOpen($)
      .then(() => refreshGit($))
      .catch(() => undefined)
    return
  }
  const cwd = await $.session.cwd()
  const files: string[] = []
  for (const word of words.slice(1)) {
    if (word.startsWith('-')) continue
    const path = absolute(cwd, word.replace(/^['"]|['"]$/g, ''))
    const stat = await $.fs.stat(path).catch(() => null)
    if (stat?.kind === 'file') files.push(path)
  }
  await touch($, files, 'read', tokens)
}

async function moveTo($: EngineInterface, cwd: string): Promise<void> {
  await update($, root, () => cwd)
  await update($, expanded, () => [])
  await update($, dirs, () => ({}))
  await update($, git, () => ({}))
  await update($, repos, () => ({}))
  await loadDir($, cwd)
}

async function toggle($: EngineInterface, dir: string): Promise<void> {
  const open = await read($, expanded)
  if (open.includes(dir)) {
    await update($, expanded, cur => cur.filter(d => d !== dir && !inside(dir, d)))
    return
  }
  await loadDir($, dir)
  await update($, expanded, cur => [...cur, dir])
}

type Row = { path: string; name: string; depth: number; isDir: boolean }

function flatten(listings: Record<string, Entry[]>, open: Set<string>, dir: string, depth: number, out: Row[]): Row[] {
  for (const entry of listings[dir] ?? []) {
    const path = join(dir, entry.name)
    out.push({ path, name: entry.name, depth, isDir: entry.isDir })
    if (entry.isDir && open.has(path)) flatten(listings, open, path, depth + 1, out)
  }
  return out
}

// A folder shows the strongest touch and the summed tokens of everything under it,
// so a collapsed folder still says Claude worked inside it.
function rollUp(top: string, touched: Record<string, Activity>): Map<string, { kind: Touch; tokens: number }> {
  const out = new Map<string, { kind: Touch; tokens: number }>()
  for (const [path, a] of Object.entries(touched)) {
    if (!inside(top, path)) continue
    for (let dir = dirname(path); inside(top, dir) && dir !== top; dir = dirname(dir)) {
      const was = out.get(dir)
      out.set(dir, { kind: was?.kind === 'write' || a.kind === 'write' ? 'write' : 'read', tokens: (was?.tokens ?? 0) + a.tokens })
    }
  }
  return out
}

export const register: Register = (on, options) => {
  follow = options.follow !== 'off'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const cwd = started.cwd || e.cwd
    await $.command.register({ name: 'context-tree', description: 'Show or hide the context tree pane' })
    if ((await read($, root)) === cwd) await reloadOpen($)
    else await moveTo($, cwd)
    void refreshGit($)
    // The desktop app starts a session in an empty spare folder and moves it into
    // the project the person picks; no event says so, so the folder is re-read here.
    $.clock.every(1000, async () => {
      const now = await $.session.cwd()
      if (!now || now === (await read($, root))) return
      await moveTo($, now)
      await refreshGit($)
    })
    void $.ui.open({ id: PANE, title: TITLE })
    return started
  })

  on('command.run', { command: 'context-tree' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'Context tree hidden.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Context tree shown.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny || ran.isError) return ran
    // Only the main thread's results land in the conversation's context.
    const chars = e.agentId ? 0 : (ran.text?.length ?? 0)
    const input = (n: number) => (e.agentId ? 0 : n)
    const work =
      e.tool === 'Read'
        ? touch($, [normalize(e.file_path)], 'read', estimate(chars))
        : e.tool === 'Write'
          ? wrote($, e.file_path, estimate(chars + input(e.content.length)))
          : e.tool === 'Edit'
            ? wrote($, e.file_path, estimate(chars + input(e.old_string.length + e.new_string.length)))
            : e.tool === 'NotebookEdit'
              ? wrote($, e.notebook_path, estimate(chars + input(e.new_source.length)))
              : e.tool === 'Bash'
                ? shell($, e.command, estimate(chars))
                : null
    // Recording the touch is a few state writes; git and folder refreshes run on in the background.
    await work?.catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const top = await read($, root)
    const touched = await read($, activity)
    const marks = await read($, git)
    const branches = await read($, repos)
    const repo = branches[top]
    const changedIn = (dir: string) => Object.keys(marks).filter(p => marks[p] !== IGNORED_MARK && inside(dir, p)).length
    const ignored = Object.keys(marks).filter(p => marks[p] === IGNORED_MARK)
    const isIgnored = (path: string) => ignored.some(dir => inside(dir, path))
    const nested = repo ? [] : Object.keys(branches).filter(p => inside(top, p))
    const lit = new Set(await read($, flash))
    const mode = await read($, view)
    const open = new Set(await read($, expanded))
    const folders = rollUp(top, touched)
    const ranked = Object.entries(touched)
      .filter(([p]) => inside(top, p))
      .sort(([, a], [, b]) => b.tokens - a.tokens || b.at - a.at)
    const total = ranked.reduce((sum, [, a]) => sum + a.tokens, 0)
    const most = ranked[0]?.[1].tokens ?? 0

    const attach = (path: string) => () => void $.prompt.fill({ text: `@${relative(top, path)} `, mode: 'insert' })
    const times = (a: { count?: number } | undefined) => (a?.count && a.count > 1 ? ` ×${a.count}` : '')

    // Every row starts with a one-glyph button in a fixed column, so folders and
    // files line up; the name sits in its own Text because a desktop button
    // draws natively and ignores a color.
    // A nested repo's folder row carries its branch: name, ↑ahead ↓behind, ±changed.
    const chip = (path: string) => {
      const b = path === top ? undefined : branches[path]
      if (!b) return null
      const changed = changedIn(path)
      return (
        <Text tabular>
          <Text color={BRAND}>⎇ {b.name.length > BRANCH_CHARS ? `${b.name.slice(0, BRANCH_CHARS - 1)}…` : b.name}</Text>
          <Text color={FAINT}>
            {b.ahead > 0 ? ` ↑${b.ahead}` : ''}
            {b.behind > 0 ? ` ↓${b.behind}` : ''}
            {changed > 0 ? ` ±${changed}` : ''}{' '}
          </Text>
        </Text>
      )
    }

    const line = (p: {
      path: string
      label: string
      depth: number
      glyph: string
      onPress: () => void
      kind: Touch | undefined
      tokens: number
      extra: string
      isDir?: boolean
      fromStart?: boolean
    }) => {
      const quiet = !p.kind && isIgnored(p.path)
      const inner = p.isDir && !(p.path !== top && branches[p.path]) ? changedIn(p.path) : 0
      return (
      <Box key={p.path} flexDirection="row" paddingLeft={p.depth * 2}>
        <Box width={3}>
          <Button key={p.path} plain dimColor label={p.glyph} onPress={p.onPress} />
        </Box>
        <Box flexGrow={1}>
          <Text color={quiet ? IGNORED : colorOf(p.kind, lit.has(p.path))} wrap={p.fromStart ? 'truncate-start' : 'truncate-end'}>
            {DOT} {p.label}
            <Text color={FAINT}>{p.extra}</Text>
          </Text>
        </Box>
        {chip(p.path)}
        <Text color={FAINT} tabular>
          {p.tokens > 0 ? `~${compact(p.tokens)}` : ''}
          {inner > 0 ? ` ±${inner}` : ''}
          {!p.isDir && marks[p.path] && marks[p.path] !== IGNORED_MARK ? ` ${marks[p.path]}` : ''}
        </Text>
      </Box>
      )
    }

    const rows =
      mode === 'touched'
        ? ranked.map(([path, a]) =>
            line({ path, label: relative(top, path), depth: 0, glyph: '@', onPress: attach(path), kind: a.kind, tokens: a.tokens, extra: times(a), fromStart: true }),
          )
        : flatten(await read($, dirs), open, top, 0, []).map(row => {
            const own = row.isDir ? folders.get(row.path) : touched[row.path]
            return line({
              path: row.path,
              label: row.isDir ? `${row.name}/` : row.name,
              depth: row.depth,
              glyph: row.isDir ? (open.has(row.path) ? '▾' : '▸') : '@',
              onPress: row.isDir ? () => void toggle($, row.path) : attach(row.path),
              kind: own?.kind,
              tokens: own?.tokens ?? 0,
              extra: row.isDir ? '' : times(touched[row.path]),
              isDir: row.isDir,
            })
          })

    const bar = (tokens: number) => {
      const filled = most > 0 && tokens > 0 ? Math.max(1, Math.round((BAR_DOTS * tokens) / most)) : 0
      return (
        <Text>
          <Text color={BRAND}>{DOT.repeat(filled)}</Text>
          <Text color={EMPTY}>{DOT.repeat(BAR_DOTS - filled)}</Text>
        </Text>
      )
    }

    const tab = (target: View, hotkey: string) => (
      <Button
        key={`view-${target}`}
        label={target}
        variant={mode === target ? 'primary' : 'secondary'}
        {...(mode === target ? {} : { hotkey })}
        onPress={() => void update($, view, () => target)}
      />
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1}>
            <Text bold wrap="truncate-end">
              {basename(top)}
            </Text>
          </Box>
          {tab('tree', 'r')}
          {tab('touched', 't')}
        </Box>
        <Text color={FAINT} wrap="truncate-end">
          {ranked.length > 0 ? `${ranked.length} touched · ~${compact(total)} tokens` : 'no files touched yet'}
        </Text>
        {repo && (
          <Text wrap="truncate-end" tabular>
            <Text color={BRAND}>⎇ {repo.name}</Text>
            <Text color={FAINT}>
              {repo.upstream ? '' : ' · no upstream'}
              {repo.ahead > 0 ? ` · ↑${repo.ahead}` : ''}
              {repo.behind > 0 ? ` · ↓${repo.behind}` : ''}
              {repo.upstream && repo.ahead === 0 && repo.behind === 0 ? ' · in sync' : ''}
              {` · ${changedIn(top) > 0 ? `${changedIn(top)} changed` : 'clean'}`}
            </Text>
          </Text>
        )}
        {nested.length > 0 && (
          <Text wrap="truncate-end" color={FAINT}>
            ⎇ {nested.length} {nested.length === 1 ? 'repo' : 'repos'} inside · {changedIn(top) > 0 ? `${changedIn(top)} changed` : 'clean'}
          </Text>
        )}
        <Text>
          <Text color={BRAND_LIGHT}>{DOT} read</Text>
          {'  '}
          <Text color={BRAND}>{DOT} written</Text>
          {'  '}
          <Text color={FAINT}>{DOT} untouched</Text>
          <Text color={FAINT}>{'  '}@ attach</Text>
        </Text>
        {mode === 'tree' && most > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={FAINT}>most context</Text>
            {ranked.slice(0, TOP_FILES).map(([path, a]) => (
              <Box key={`top-${path}`} flexDirection="row" gap={1}>
                {bar(a.tokens)}
                <Box flexGrow={1}>
                  <Text wrap="truncate-start">{relative(top, path)}</Text>
                </Box>
                <Text color={FAINT} tabular>
                  ~{compact(a.tokens)}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        <Box marginTop={1} flexDirection="column">
          {rows.length === 0 && (
            <Text color={FAINT}>{mode === 'touched' ? 'Claude has not read or written a file yet.' : 'Empty folder.'}</Text>
          )}
          {rows}
        </Box>
      </Box>
    )
  })
}
