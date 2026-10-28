import { z } from 'zod'

/** Native catalog effort values are extensible strings in the selected app-server protocol. */
export type CodexModelOptions = Readonly<{ reasoningEffort?: string; fastMode?: boolean }>
const options = z.object({
  reasoningEffort: z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value)).optional(),
  fastMode: z.boolean().optional(),
})
/** Shared captured CLI configuration for ordinary sessions and finite model probes. False preserves native defaults. */
export function codexModelOptionArgs(selected: CodexModelOptions): readonly string[] {
  try {
    const parsed = options.safeParse({ reasoningEffort: selected.reasoningEffort, fastMode: selected.fastMode })
    if (parsed.success) {
      return Object.freeze([
        ...(parsed.data.reasoningEffort === undefined ? [] : ['-c', `model_reasoning_effort=${JSON.stringify(parsed.data.reasoningEffort)}`]),
        ...(parsed.data.fastMode === true ? ['-c', 'service_tier="fast"', '-c', 'features.fast_mode=true'] : []),
      ])
    }
  } catch { /* Caller configuration failures must not expose private values. */ }
  throw new Error('codex.options.invalid-config')
}
