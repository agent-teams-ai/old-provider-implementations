import { captureClaudeExtraArgs } from '../provider-session-io/extra-argv.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import type { Limits } from '@agent-teams/provider-session-contracts';
import { record } from './normalize.ts';
import { subagentOptions, validSubagents } from './subagents.ts';
import type { ClaudeSubagentPort } from './subagents.ts';
import type { ClaudeToolBinding } from './tool-binding.ts';
import type { ClaudeCapturePort } from './capture.ts';
import { attachmentCompatibility, snapshotAttachmentPort } from '../provider-session-io/attachments.ts';
import type { AttachmentPort } from '../provider-session-io/attachments.ts';
export const SDK_REVISION = '0.3.305';
type ClaudeCloseObservation = Readonly<
  { stage: 'custody'; outcome: 'confirmed' | 'unconfirmed' | 'error' } |
  { stage: 'sdk-close' | 'sdk-read' | 'capture-close'; outcome: 'completed' | 'error' }
>;
export type ClaudeConfig = {
  sessionRef: string;
  trustedBinding: string;
  cwd: string;
  model: string;
  accountBinding: string;
  configRevision: string;
  environment: Record<string, string>;
  attachments?: AttachmentPort;
  /** Host admits native flag/value arity; D independently refuses managed native overrides. */
  extraArgs?: readonly string[];
  /** Omission preserves the existing explicit custom-directory requirement. */
  configNamespace?: 'native-default' | 'custom-directory';
  /** Trusted, selected native configuration. No arbitrary SDK options, settings or hooks. */
  nativeOptions?: {
    permissionMode?: NonNullable<Options['permissionMode']>;
    allowDangerouslySkipPermissions?: boolean;
    settingSources?: NonNullable<Options['settingSources']>;
    projectInstructions?: { append?: string };
    effort?: NonNullable<Options['effort']>;
    fastMode?: boolean;
    /** model-default preserves the Host-selected model, including its [1m] suffix. */
    context?: 'model-default' | 'one-million';
  };
  subagents?: ClaudeSubagentPort;
  nativeTools: string[];
  autoAllowedTools: string[];
  mcpServers: Record<string, Exclude<McpServerConfig, { type: 'sdk' }>>;
  requiredTools: Record<string, string[]>;
  /** A read-only host handshake; no mutation and no model prompt. */
  probe: (signal: AbortSignal) => Promise<boolean>;
  limits: Limits;
  toolBinding?: ClaudeToolBinding;
  /** Best-effort private native observations; never tool authorization or product policy. */
  capture?: ClaudeCapturePort;
  /** Private, bounded stage observations only; never raw provider errors or cleanup authority. */
  observeClose?: (observation: ClaudeCloseObservation) => void | Promise<void>;
  sessionExists: (nativeSession: string) => Promise<boolean>;
  /** Runtime/test Host owns the actual child and must sanitize launch environment. */
  custody: {
    launch: NonNullable<Options['spawnClaudeCodeProcess']>;
    confirmStopped: () => Promise<boolean>;
  };
};
export type Checkpoint = { version: 1; engine: string; nativeSession: string; compatibility: string };
export function compatibility(config: ClaudeConfig): string {
  const { cwd, accountBinding, configRevision, model, trustedBinding, nativeTools, autoAllowedTools, requiredTools } = config;
  return createHash('sha256').update(JSON.stringify({ cwd, accountBinding, configRevision, model, trustedBinding, nativeTools, autoAllowedTools, requiredTools,
    toolBindingTools: config.toolBinding?.matchedToolNames,
    ...(config.subagents ? { subagents: { mode: config.subagents.mode, tools: config.subagents.tools } } : {}),
    ...((config.extraArgs?.length ?? 0) > 0 ? { extraArgs: config.extraArgs } : {}),
    ...(config.attachments ? { attachments: attachmentCompatibility(config.attachments) } : {}),
    ...(config.nativeOptions ? { nativeOptions: selectedOptions(config) } : {}),
    ...(config.configNamespace ? { configNamespace: config.configNamespace, home: config.environment.HOME,
      configDirectory: config.environment.CLAUDE_CONFIG_DIR } : {}) })).digest('hex');
}
export function validConfig(c: ClaudeConfig): boolean {
  return !!(c.sessionRef && c.trustedBinding && c.accountBinding && c.configRevision && c.model && c.cwd.startsWith('/') &&
    nonempty(c.environment.HOME) && nonempty(c.environment.PATH) &&
    validNamespace(c) &&
    validNativeOptions(c.nativeOptions) &&
    Object.values(c.limits).every((v) => Number.isSafeInteger(v) && v > 0) &&
    !Object.keys(c.environment).some((key) => /^(CLAUDE_CODE_TEAM|CLAUDE_TEAM|CLAUDE_AGENT_TEAMS|CLAUDE_CODE_RESUME|CLAUDE_CODE_CONTINUE)/.test(key)) &&
    validTools(c) &&
    (!c.toolBinding || (c.toolBinding.matchedToolNames.length > 0 && c.toolBinding.matchedToolNames.every((name) => typeof name === 'string' && !!name) && typeof c.toolBinding.prepare === 'function')) &&
    validCapture(c.capture, c.observeClose) &&
    Object.keys(c.requiredTools).every((name) => Object.hasOwn(c.mcpServers, name)));
}
export function options(c: ClaudeConfig, nativeSession: string, restore: boolean): Options {
  const extraArgs = c.extraArgs ?? [];
  return {
    cwd: c.cwd, model: c.model, env: { ...c.environment }, ...selectedOptions(c),
    ...(c.subagents ? subagentOptions(c.subagents) : {}),
    tools: [...c.nativeTools], allowedTools: [...c.autoAllowedTools],
    mcpServers: c.mcpServers, strictMcpConfig: true,
    persistSession: true, includePartialMessages: true,
    ...(restore ? { resume: nativeSession } : { sessionId: nativeSession }),
    spawnClaudeCodeProcess: (spawnOptions) => c.custody.launch({ ...spawnOptions, ...(extraArgs.length ? { args: [...spawnOptions.args, ...extraArgs] } : {}), env: { ...c.environment } }),
  };
}
export function freshNativeSession(): string { return randomUUID(); }
export function readCheckpoint(value: unknown): Checkpoint | undefined {
  if (value === null || typeof value !== 'object') {return undefined;}
  const cp = value as Record<string, unknown>;
  return cp.version === 1 && typeof cp.engine === 'string' && typeof cp.nativeSession === 'string' &&
    typeof cp.compatibility === 'string' ? { version: 1, engine: cp.engine, nativeSession: cp.nativeSession, compatibility: cp.compatibility } : undefined;
}

/** Pin the caller's private projection once; later caller mutation cannot change a session. */
export function snapshotConfig(c: ClaudeConfig): ClaudeConfig {
  const { extraArgs: supplied, ...base } = c;
  const extraArgs = captureClaudeExtraArgs(supplied);
  return { ...base, ...(extraArgs.length ? { extraArgs } : {}), ...(c.subagents ? { subagents: Object.freeze({ mode: c.subagents.mode, tools: Object.freeze([...c.subagents.tools]), authorize: c.subagents.authorize, observe: c.subagents.observe }) } : {}), environment: { ...c.environment }, nativeTools: [...c.nativeTools],
    ...(c.capture ? { capture: Object.freeze({ observe: c.capture.observe, ...(c.capture.observeBatch ? { observeBatch: c.capture.observeBatch } : {}), ...(c.capture.observeBackground ? { observeBackground: c.capture.observeBackground } : {}) }) } : {}),
    ...(c.attachments !== undefined ? { attachments: snapshotAttachmentPort(c.attachments)! } : {}),
    ...(c.nativeOptions ? { nativeOptions: structuredClone(c.nativeOptions) } : {}),
    autoAllowedTools: [...c.autoAllowedTools], requiredTools: structuredClone(c.requiredTools),
    mcpServers: structuredClone(c.mcpServers), ...(c.toolBinding ? { toolBinding: { ...c.toolBinding, matchedToolNames: [...c.toolBinding.matchedToolNames] } } : {}), limits: { ...c.limits }, custody: { ...c.custody } };
}

function validCapture(capture: ClaudeCapturePort | undefined, observeClose: ClaudeConfig['observeClose']): boolean {
  return (observeClose === undefined || typeof observeClose === 'function') && (!capture || (typeof capture.observe === 'function' && (capture.observeBatch === undefined || typeof capture.observeBatch === 'function') &&
    (capture.observeBackground === undefined || typeof capture.observeBackground === 'function')));
}
function listed(value: unknown, allowed: readonly unknown[]): boolean { return allowed.includes(value); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function validNamespace(c: ClaudeConfig): boolean {
  const namespace: unknown = c.configNamespace;
  return namespace === 'native-default' ? !Object.hasOwn(c.environment, 'CLAUDE_CONFIG_DIR') :
    (namespace === undefined || namespace === 'custom-directory') && nonempty(c.environment.CLAUDE_CONFIG_DIR);
}

function selectedOptions(c: ClaudeConfig): Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions' | 'settingSources' | 'systemPrompt' | 'effort' | 'settings' | 'betas'> {
  const n = c.nativeOptions;
  return { permissionMode: n?.permissionMode ?? 'default', settingSources: [...(n?.settingSources ?? [])],
    ...(n?.allowDangerouslySkipPermissions !== undefined ? { allowDangerouslySkipPermissions: n.allowDangerouslySkipPermissions } : {}),
    ...(n?.projectInstructions ? { systemPrompt: { type: 'preset', preset: 'claude_code', ...(n.projectInstructions.append !== undefined ? { append: n.projectInstructions.append } : {}) } } : {}),
    ...(n?.effort !== undefined ? { effort: n.effort } : {}),
    ...(n?.fastMode !== undefined ? { settings: { fastMode: n.fastMode } } : {}),
    ...(n?.context === 'one-million' ? { betas: ['context-1m-2025-08-07'] } : {}),
  };
}

function validNativeOptions(value: unknown): boolean {
  if (value === undefined) { return true; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const n = record(value);
  if (Object.keys(n).some(key => !['permissionMode', 'allowDangerouslySkipPermissions', 'settingSources', 'projectInstructions', 'effort', 'fastMode', 'context'].includes(key))) { return false; }
  return validPermissionOptions(n) &&
    (n.settingSources === undefined || (Array.isArray(n.settingSources) && n.settingSources.every((source: unknown) => listed(source, ['user', 'project', 'local'])))) &&
    validInstructions(n.projectInstructions) &&
    (n.effort === undefined || listed(n.effort, ['low', 'medium', 'high', 'xhigh', 'max'])) &&
    (n.fastMode === undefined || typeof n.fastMode === 'boolean') &&
    (n.context === undefined || listed(n.context, ['model-default', 'one-million']));
}

function validPermissionOptions(n: Record<string, unknown>): boolean {
  return (n.permissionMode === undefined || listed(n.permissionMode, ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])) &&
    (n.allowDangerouslySkipPermissions === undefined || typeof n.allowDangerouslySkipPermissions === 'boolean') &&
    (n.permissionMode !== 'bypassPermissions' || n.allowDangerouslySkipPermissions === true);
}
function validInstructions(value: unknown): boolean {
  if (value === undefined) { return true; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const fields = record(value);
  return Object.keys(fields).every(key => key === 'append') && (fields.append === undefined || typeof fields.append === 'string');
}

function validTools(c: ClaudeConfig): boolean {
  return !c.nativeTools.some(tool => /^(Team|Task|TodoWrite|Cron|Schedule|SendMessage$|ListAgents$)/.test(tool) ||
    (tool.startsWith('Agent') && (tool !== 'Agent' || !c.subagents))) &&
    validSubagents(c.subagents, c.nativeTools) && (!c.subagents || c.nativeOptions?.permissionMode !== 'plan');
}
