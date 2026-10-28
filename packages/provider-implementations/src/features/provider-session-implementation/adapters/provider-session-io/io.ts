export function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, resolve: settle };
}
export async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('deadline')); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
/** Single-consumer, byte-and-count bounded event feed. Never silently drops output. */
export class EventFeed<T> implements AsyncIterable<T> {
  private readonly values: { value: T; bytes: number }[] = [];
  private bytes = 0;
  private ended = false;
  private waiter = deferred<void>();
  private claimed = false;
  private terminal: { value: T } | undefined;
  private readonly maxCount: number;
  private readonly maxBytes: number;
  constructor(maxCount: number, maxBytes: number) { this.maxCount = maxCount; this.maxBytes = maxBytes; }
  push(value: T): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (this.ended || this.values.length >= this.maxCount || this.bytes + bytes > this.maxBytes) {return false;}
    this.values.push({ value, bytes }); this.bytes += bytes;
    this.wake(); return true;
  }
  finishWith(value: T): void {
    if (!this.terminal) {this.terminal = { value };}
    this.end();
  }
  end(): void { this.ended = true; this.wake(); }
  private wake(): void { this.waiter.resolve(); this.waiter = deferred<void>(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    if (this.claimed) {throw new Error('single observer required');}
    this.claimed = true;
    for (;;) {
      const next = this.values.shift();
      if (next) { this.bytes -= next.bytes; yield next.value; }
      else if (this.ended) {
        if (this.terminal) { const terminal = this.terminal; this.terminal = undefined; yield terminal.value; }
        return;
      }
      else {await this.waiter.promise;}
    }
  }
}
