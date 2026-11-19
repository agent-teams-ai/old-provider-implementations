import type { EventPayload } from '@agent-teams/provider-session-contracts';

/** Read-only projection of the commands advertised by this exact live SDK Query. */
export interface ClaudeCommandDescription {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
  readonly aliases?: readonly string[];
  readonly builtin?: true;
  /** Adapter-owned invocation semantics; the canonical native row remains unchanged. */
  readonly compatibility?: {
    readonly invocation: 'review'; readonly execution: 'legacy-inline-review-v1';
    readonly description: string; readonly argumentHint: string;
  };
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

const legacyReview = Object.freeze({ invocation: 'review', execution: 'legacy-inline-review-v1',
  description: 'Review a pull request in the current conversation.', argumentHint: '[pr number]' } as const);
const legacyReviewCommand = (command: ClaudeCommandDescription | undefined): boolean =>
  command?.name === 'code-review' && command.builtin === true && command.aliases?.includes('review') === true;

/** Annotate only the qualified alias; never accept execution metadata from supportedCommands(). */
export function projectClaudeCommands(commands: readonly ClaudeCommandDescription[]): readonly ClaudeCommandDescription[] {
  const selected = resolveClaudeCommand(commands, 'review');
  if (!legacyReviewCommand(selected)) { return commands; }
  const observed = Object.freeze(commands.map(command => command === selected
    ? Object.freeze({ ...command, compatibility: legacyReview }) : command));
  return Buffer.byteLength(JSON.stringify(observed)) <= 256 * 1024 ? observed : Object.freeze([]);
}

/** Exact inline recipe from runtime 0.0.158/0.0.160 review.ts (f86ada0b); not the SDK's newer fork. */
export function claudeLegacyReviewContent(input: string, command: ClaudeCommandDescription | undefined): string | undefined {
  const raw = input.trim();
  if (!legacyReviewCommand(command) || (raw !== '/review' && !raw.startsWith('/review '))) { return; }
  const args = raw === '/review' ? '' : raw.slice('/review '.length);
  return `
      You are an expert code reviewer. Follow these steps:

      1. If no PR number is provided in the args, run \`gh pr list\` to show open PRs
      2. If a PR number is provided, run \`gh pr view <number>\` to get PR details
      3. Run \`gh pr diff <number>\` to get the diff
      4. Analyze the changes and provide a thorough code review that includes:
         - Overview of what the PR does
         - Analysis of code quality and style
         - Specific suggestions for improvements
         - Any potential issues or risks

      Keep your review concise but thorough. Focus on:
      - Code correctness
      - Following project conventions
      - Performance implications
      - Test coverage
      - Security considerations

      Format your review with clear sections and bullet points.

      PR number: ${args}
    `;
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
