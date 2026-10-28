export type Limit = {
  kind: string
  percent: number
  resetsAt: number | null
}

export type Meter = {
  contextTokens: number | null
  window: number
  percent: number | null
  usd: number | null
  startedAt: number
  turns: number
  limits: Limit[]
}

export type Growth = {
  tokens: number
  label: string | null
}

export type Level = 'ok' | 'warn' | 'alert'

export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
  firstSeenAt: number
  outputTokens: number
  contextTokens: number
  model: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-meter': {
      meter: Meter | null
      history: number[]
      growth: Growth | null
      cacheHit: number | null
      warned: Level
      agents: AgentRow[]
      now: number
      isHidden: boolean
    }
  }
}
