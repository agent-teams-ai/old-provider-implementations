/** Await bound for finite native requests; owning transport cancels its IO on failure. */
export async function boundV2Request<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  try {
    signal?.throwIfAborted()
    if (!Number.isFinite(ms) || ms <= 0) {throw new Error('deadline')}
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () =>{  reject(new Error('deadline')); }
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(abort, ms)
    })])
  } finally { clearTimeout(timer); if (abort) {signal?.removeEventListener('abort', abort)} }
}
