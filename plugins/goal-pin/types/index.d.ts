// text '' means the person cleared the goal, so the first prompt is not taken again.
export type GoalInfo = { text: string; auto: boolean }

declare module 'claude-code' {
  interface PluginState {
    'goal-pin': {
      goal: GoalInfo | null
    }
  }
}
