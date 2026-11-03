/**
 * Running a refresh as named steps.
 *
 * Each endpoint below is a chain of pulls that write different collections. v1
 * ran them as one unguarded sequence inside a serverless function, so the first
 * failure abandoned everything after it and answered with an opaque 500. A
 * scheduler needs better than that: the steps run in order, a failure is
 * recorded and the rest still run, and the response says what happened to each
 * one — which is what a cron log is for.
 */

export interface RefreshStep {
  name: string
  run: () => Promise<unknown>
}

export interface StepResult {
  name: string
  ok: boolean
  durationMs: number
  /** What the step wrote, when it succeeded. */
  detail?: unknown
  error?: string
}

export interface RefreshReport {
  ok: boolean
  durationMs: number
  steps: StepResult[]
}

export async function runRefresh(steps: RefreshStep[]): Promise<RefreshReport> {
  const startedAt = Date.now()
  const results: StepResult[] = []

  for (const step of steps) {
    const stepStartedAt = Date.now()
    try {
      const detail = await step.run()
      const durationMs = Date.now() - stepStartedAt
      results.push({ name: step.name, ok: true, durationMs, detail })
      console.log(`[cron] ${step.name} ok in ${durationMs}ms`, detail ?? '')
    } catch (cause) {
      const durationMs = Date.now() - stepStartedAt
      const error = cause instanceof Error ? cause.message : String(cause)
      results.push({ name: step.name, ok: false, durationMs, error })
      console.error(`[cron] ${step.name} failed in ${durationMs}ms: ${error}`)
    }
  }

  return {
    ok: results.every((result) => result.ok),
    durationMs: Date.now() - startedAt,
    steps: results,
  }
}
