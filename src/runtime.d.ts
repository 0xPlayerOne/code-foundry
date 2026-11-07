export interface TaskProfile {
  task: string
  applicable: boolean
  required: boolean
  reason: string
  source: string
  affected: string
  javascript: string
  python: string
  rust: string
}

export function taskProfile(root: string, task: string, entry?: string): TaskProfile
export interface RuntimeOptions {
  /** Monotonic clock in nanoseconds; defaults to process.hrtime.bigint. */
  clock?: () => bigint
}

export function runRuntime(
  args: string[],
  root?: string,
  entry?: string,
  options?: RuntimeOptions
): number
