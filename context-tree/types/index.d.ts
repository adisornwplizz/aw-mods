export type Touch = 'read' | 'write'

export type Activity = {
  kind: Touch
  tokens: number
  count: number
  at: number
}

export type Entry = {
  name: string
  isDir: boolean
}

export type View = 'tree' | 'touched'

export type Branch = {
  name: string
  upstream: string | null
  ahead: number
  behind: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-tree': {
      root: string
      activity: Record<string, Activity>
      dirs: Record<string, Entry[]>
      expanded: string[]
      git: Record<string, string>
      repos: Record<string, Branch>
      flash: string[]
      view: View
    }
  }
}
