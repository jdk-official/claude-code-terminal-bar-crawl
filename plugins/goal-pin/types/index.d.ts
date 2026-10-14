// text '' means the person cleared the goal, so the first prompt is not taken again.
export type GoalInfo = { text: string; auto: boolean }

declare module 'claude-code' {
  interface PluginState {
    'goal-pin': {
      goal: GoalInfo | null
      // The PBI the git branch names, shown when there is no goal.
      pbi: { text: string } | null
      // How many PBI refreshes this session has started; guards against stale writes.
      refreshes: number
    }
  }
}
