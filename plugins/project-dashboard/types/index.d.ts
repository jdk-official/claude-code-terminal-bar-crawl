export type GitInfo = {
  branch: string
  ahead: number
  behind: number
  changed: number
  untracked: number
}

export type Listener = { port: number; name: string; pid: number }

export type BoardItem = {
  id: string
  title: string
  section: string
  deps: string[]
  risk: string
  branch: string
}

export type BoardInfo = {
  counts: Record<string, number>
  active: BoardItem[]
  items: BoardItem[]
}

export type DocItem = { path: string; name: string; group: string }

declare module 'claude-code' {
  interface PluginState {
    'project-dashboard': {
      git: GitInfo | null
      ports: Listener[]
      board: BoardInfo | null
      docs: DocItem[]
      pbiFiles: Record<string, string>
      project: string | null
      lastRepo: string | null
      notice: string | null
      collapsed: string[]
    }
  }
}
