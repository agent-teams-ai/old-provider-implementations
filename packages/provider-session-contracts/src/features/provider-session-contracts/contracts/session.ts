interface SessionRef {readonly tenantId: string; readonly projectId: string; readonly sessionId: string; readonly generation: number}

/** Consumer-owned provider SPI. No SDK, process, environment or native session types. */
export type FailureCode = "invalid-config" | "unavailable" | "dependency-unavailable" |
  "backpressure" | "stale" | "unsupported" | "checkpoint-incompatible" |
  "checkpoint-missing" | "provider-failure" | "output-limit" | "unknown";
export type Failure = {readonly ok: false; readonly code: FailureCode; readonly delivery?: "known-not-sent"};
export type Reply<T> = {readonly ok: true; readonly value: T} | Failure;
export type Input = {readonly inputId: string; readonly operationRef: string; readonly content: string;
  /** Ordered immutable artifact references; bytes and native paths remain consumer-owned. digest is lowercase SHA-256 hex. */
  readonly attachments?: readonly {readonly artifactId: string; readonly mimeType: string; readonly byteLength: number; readonly digest: string}[]};
/** Consumption of stdin/SDK input is not provider acceptance or terminal completion. */
export type Handoff = {readonly inputId: string; readonly operationRef: string; readonly delivery: "client-consumed"; readonly providerAcceptance: "unknown"};
export type InteractionReply = {readonly kind: "permission"; readonly decision: "allow" | "deny"} |
  {readonly kind: "question"; readonly answers: Readonly<Record<string, string>>; readonly decision?: never} |
  {readonly kind: "question"; readonly decision: "deny"; readonly answers?: never};
export type EventPayload =
  /** One observed provider context boundary; sourceRef is opaque and stable within the native session. */
  {readonly kind: "compaction"; readonly sourceRef: string; readonly reason: "manual" | "automatic" | "unknown"} |
  {readonly kind: "text"; readonly messageRef: string; readonly block: number; readonly text: string; readonly phase: "snapshot" | "complete"} |
  {readonly kind: "tool"; readonly messageRef: string; readonly toolRef: string; readonly name: string; readonly input: unknown} |
  {readonly kind: "tool-result"; readonly toolRef: string; readonly content: unknown; readonly isError: boolean} |
  {readonly kind: "usage"; readonly inputTokens?: number; readonly outputTokens?: number; readonly cumulativeCostUsd?: number} |
  {readonly kind: "result"; readonly outcome: "succeeded" | "failed" | "cancelled" | "unknown"; readonly code?: FailureCode} |
  {readonly kind: "interaction"; readonly interactionRef: string; readonly request: {readonly kind: "permission"; readonly tool: string; readonly input: unknown} | {readonly kind: "question"; readonly questions: unknown}} |
  {readonly kind: "diagnostic"; readonly code: FailureCode | "unknown-event" | "iterator-ended"};
export type Event = {readonly sessionRef: string; readonly operationRef?: string; readonly inputId?: string} & EventPayload;
export type Limits = {readonly queuedInputs: number; readonly inputBytes: number; readonly outputBytes: number; readonly outputEvents: number; readonly pendingInteractions: number; readonly timeoutMs: number};
export type CloseReceipt = {readonly logicallyClosed: true; readonly cleanup: "confirmed" | "unknown"};
export interface Session {
  readonly sessionRef: string;
  readonly submit: (input: Input) => Promise<Reply<Handoff>>;
  readonly observe: () => AsyncIterable<Event>;
  readonly respondToInteraction: (ref: string, reply: InteractionReply) => Reply<void> | Promise<Reply<void>>;
  readonly interrupt: (operationRef: string) => Promise<Reply<{readonly requested: true; readonly terminal: "unconfirmed"}>>;
  readonly checkReadiness: () => Promise<Reply<void>>;
  readonly checkpoint: () => Reply<unknown>;
  readonly close: () => Promise<CloseReceipt>;
}
/** Trusted composition resolves provider configuration and private checkpoint bytes. */
export interface OpenConfig extends SessionRef {
  readonly configRevision: string;
  readonly requiredCapabilities: readonly string[];
  readonly checkpointRef?: string;
}
export interface OpenedSession {readonly driver: Session; readonly capabilities: readonly string[]}
export interface DriverFactory {readonly open: (config: OpenConfig) => Promise<OpenedSession>}
