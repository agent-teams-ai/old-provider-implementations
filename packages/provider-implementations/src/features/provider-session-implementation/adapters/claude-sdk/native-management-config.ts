import { z } from 'zod';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

/** Private configuration shared by finite native metadata and explicit model tests. */
export type ClaudeNativeManagementConfig = {
  cwd: string;
  executablePath: string;
  environment: Record<string, string>;
  configNamespace: 'native-default' | 'custom-directory';
  settingSources?: NonNullable<Options['settingSources']>;
  timeoutMs: number;
  /** Caller owns the selected native child and physical cleanup. */
  launch: NonNullable<Options['spawnClaudeCodeProcess']>;
  /** Close the original owned process before SDK EOF/abort can retire its root. Reuse the caller's cached cleanup promise. */
  confirmStopped: () => Promise<boolean>;
};
const absolutePath = z.string().min(1).max(8192).startsWith('/').refine(value => !value.includes('\0'));
export const nativeManagementConfiguration = z.object({
  cwd: absolutePath, executablePath: absolutePath,
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(65536)),
  configNamespace: z.enum(['native-default', 'custom-directory']),
  settingSources: z.array(z.enum(['user', 'project', 'local'])).max(3).optional(),
  timeoutMs: z.number().int().min(1).max(180000),
  launch: z.custom<ClaudeNativeManagementConfig['launch']>(value => typeof value === 'function'),
  confirmStopped: z.custom<ClaudeNativeManagementConfig['confirmStopped']>(value => typeof value === 'function'),
}).strict().refine(value => absolutePath.safeParse(value.environment.HOME).success && (value.environment.PATH !== undefined && value.environment.PATH.length > 0) &&
  (value.configNamespace === 'native-default' ? !Object.hasOwn(value.environment, 'CLAUDE_CONFIG_DIR') : absolutePath.safeParse(value.environment.CLAUDE_CONFIG_DIR).success) &&
  !Object.keys(value.environment).some(key => /^(CLAUDE_CODE_TEAM|CLAUDE_TEAM|CLAUDE_AGENT_TEAMS|CLAUDE_CODE_RESUME|CLAUDE_CODE_CONTINUE)/.test(key)));
