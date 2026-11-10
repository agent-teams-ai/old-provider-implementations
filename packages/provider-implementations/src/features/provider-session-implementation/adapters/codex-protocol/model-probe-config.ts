import { z } from 'zod'
import type { CodexModelOptions } from './model-options.ts'
import type { CodexAppServerTransport } from './rpc-types.ts'

export type CodexModelProbeLaunch = Readonly<{ command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; signal: AbortSignal }>
/** One captured child only; the caller owns allocation and physical custody. */
export type CodexModelProbeConnection = { transport: CodexAppServerTransport; dispose: () => Promise<boolean> }
export type CodexModelProbeConfig = CodexModelOptions & {
  cwd: string; executablePath: string; environment: Record<string, string>; model: string; modelProvider?: string; timeoutMs: number
  launch: (request: CodexModelProbeLaunch) => CodexModelProbeConnection
  canSubmit: () => boolean
}
const path = z.string().min(1).max(8192).startsWith('/').refine(value => !/[\0\r\n]/u.test(value))
const name = z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value))
const schema = z.object({ cwd: path, executablePath: path, model: name, modelProvider: name.optional(), reasoningEffort: name.optional(), fastMode: z.boolean().optional(), timeoutMs: z.number().int().min(1).max(180000),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string().max(65536)).refine(value => Object.keys(value).length <= 256),
  launch: z.custom<CodexModelProbeConfig['launch']>(value => typeof value === 'function'), canSubmit: z.custom<() => boolean>(value => typeof value === 'function'),
}).strict().refine(value => path.safeParse(value.environment.HOME).success && value.environment.PATH !== undefined && value.environment.PATH.length > 0 &&
  path.safeParse(value.environment.CODEX_HOME).success)
export function captureCodexModelProbe(selected: CodexModelProbeConfig): CodexModelProbeConfig {
  try {
    const parsed = schema.safeParse({ ...selected })
    if (parsed.success) {
      const { modelProvider, reasoningEffort, fastMode, ...data } = parsed.data
      return { ...data, ...(modelProvider === undefined ? {} : { modelProvider }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(fastMode === undefined ? {} : { fastMode }), environment: Object.freeze({ ...data.environment }),
        launch: data.launch.bind(selected), canSubmit: data.canSubmit.bind(selected) }
    }
  } catch { /* Reflective caller failures must not disclose raw private configuration. */ }
  throw new Error('codex.probe.invalid-config')
}
