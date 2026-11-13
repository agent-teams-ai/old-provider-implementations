import type { EventPayload } from '@agent-teams/provider-session-contracts';

/** Read-only projection of the commands advertised by this exact live SDK Query. */
export interface ClaudeCommandDescription {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
  readonly aliases?: readonly string[];
  readonly builtin?: true;
}
const name = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9:-]{0,63}$/iu.test(value);
// The SDK also lists private builtin names; they are metadata, not product commands.
const metadataName = (value: unknown): value is string => typeof value === 'string' && /^[a-z_][a-z0-9_:-]{0,63}$/iu.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');

/** Malformed or excessive metadata provides no command authority, while ordinary input remains usable. */
export function captureClaudeCommands(value: unknown): readonly ClaudeCommandDescription[] {
  if (!Array.isArray(value) || value.length > 2048) { return []; }
  const result: ClaudeCommandDescription[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { return []; }
    const row = item as Record<string, unknown>;
    if (!metadataName(row.name) || !text(row.description, 4096) || !text(row.argumentHint, 512) ||
      (row.builtin !== undefined && typeof row.builtin !== 'boolean') ||
      (row.aliases !== undefined && (!Array.isArray(row.aliases) || row.aliases.length > 32 || !row.aliases.every(metadataName)))) { return []; }
    result.push(Object.freeze({ name: row.name, description: row.description, argumentHint: row.argumentHint,
      ...(Array.isArray(row.aliases) ? { aliases: Object.freeze([...new Set(row.aliases as string[])]) } : {}),
      ...(row.builtin === true ? { builtin: true as const } : {}),
    }));
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) { return []; }
  return Object.freeze(result.filter(command => name(command.name)).map(command => Object.freeze({
    ...command,
    ...(command.aliases ? { aliases: Object.freeze(command.aliases.filter(name)) } : {}),
  })));
}

/** Exact names win over aliases; builtin precedence describes a name, not an alias. */
export function resolveClaudeCommand(commands: readonly ClaudeCommandDescription[], supplied: string): ClaudeCommandDescription | undefined {
  const exact = commands.filter(command => command.name === supplied);
  if (exact.length) { return exact.find(command => command.builtin) ?? exact[0]; }
  const aliases = commands.filter(command => command.aliases?.includes(supplied));
  return aliases.length === 1 ? aliases[0] : undefined;
}

export function claudeCommandName(input: string): string | undefined {
  return /^\/([a-z][a-z0-9:-]{0,63})(?:\s+[\s\S]*)?$/iu.exec(input.trim())?.[1];
}

/** Caller has already proved the original native user UUID; an unbound output frame never reaches here. */
export function claudeLocalCommandText(
  message: Record<string, unknown>, input: string, capturedCommand?: ClaudeCommandDescription
): EventPayload | undefined {
  const command = claudeCommandName(input);
  if (!command || message.type !== 'result' || message.subtype !== 'success' ||
    typeof message.local_command !== 'string' || typeof message.result !== 'string' || !message.result ||
    typeof message.uuid !== 'string' || !message.uuid || message.uuid.length > 256) { return; }
  const native = message.local_command.startsWith('/') ? message.local_command.slice(1) : message.local_command;
  if (!name(native) || (native !== command && capturedCommand?.name !== native)) { return; }
  return { kind: 'text', messageRef: `local-command:${message.uuid}`, block: 0, text: message.result, phase: 'complete' };
}
