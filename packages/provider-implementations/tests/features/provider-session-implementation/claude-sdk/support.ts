import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { OpenConfig } from '@agent-teams/provider-session-contracts';
import type { ClaudeConfig, ClaudeSdkBoundary } from '../../../../src/claude.ts';

function latch() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
export class QueryFixture {
  options!: Options;
  inputs: SDKUserMessage[] = [];
  readonly messages: unknown[] = [];
  private changed = latch();
  private ended = false;
  calls = 0;
  readonly boundary: ClaudeSdkBoundary = {
    query: args => {
      this.calls++;
      this.options = args.options;
      void (async () => { for await (const input of args.prompt) { this.inputs.push(input); } })();
      return this;
    },
    sessionExists: async () => true,
  };
  async mcpServerStatus() { return []; }
  async interrupt(): Promise<undefined> { return undefined; }
  close(): void { this.ended = true; this.wake(); }
  emit(value: unknown): void { this.messages.push(value); this.wake(); }
  private wake(): void { this.changed.release(); this.changed = latch(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (!this.ended) {
      if (this.messages.length) { yield this.messages.shift(); }
      else { await this.changed.promise; }
    }
  }
}
export const request: OpenConfig = { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-session', generation: 1, configRevision: 'TEST-config', requiredCapabilities: ['text'] };
export const configuration = (): ClaudeConfig => ({
  sessionRef: request.sessionId, trustedBinding: 'TEST-private-binding', accountBinding: 'TEST-account', configRevision: request.configRevision,
  cwd: '/TEST-unused/workspace', model: 'fixture-model', environment: { HOME: '/TEST-unused/home', CLAUDE_CONFIG_DIR: '/TEST-unused/config', PATH: '/usr/bin:/bin' },
  nativeTools: ['Read', 'AskUserQuestion'], autoAllowedTools: [], mcpServers: {}, requiredTools: {},
  probe: async () => true, sessionExists: async () => true,
  limits: { queuedInputs: 2, inputBytes: 1024, outputBytes: 10000, outputEvents: 100, pendingInteractions: 2, timeoutMs: 300 },
  custody: { launch: () => { throw new Error('unit fixture never launches'); }, confirmStopped: async () => true },
});
