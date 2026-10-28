import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import type { TestContext } from 'node:test'
import type { CodexAppServerTransport } from '../../../../src/codex.ts'

type Message = Record<string, unknown>
export function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  return { promise: new Promise(resolve => { release = resolve }), release: () => release() }
}

export async function fixture(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), 'TEST-codex-rpc-'))
  const child = spawn(process.execPath, [resolvePath('tests/fixtures/codex-app-server.ts')], {
    cwd: sandbox, env: { HOME: sandbox, NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
  assert.ok(child.stdin && child.stdout && child.stderr)
  const { stdin, stdout, stderr } = child
  const messages: Message[] = []
  const changed = new Set<() => void>()
  const writes: Message[] = []
  let blocking: { started: ReturnType<typeof gate>; released: ReturnType<typeof gate> } | undefined
  let nextCommand = 0
  child.on('message', value => { messages.push(value as Message); for (const notify of changed) {notify()} })
  stderr.on('data', () => {})
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGTERM') // This fixture's own child only.
      await closed
    }
    await rm(sandbox, { recursive: true, force: true })
  })
  const waitFor = (predicate: (value: Message) => boolean): Promise<Message> => {
    const existing = messages.find(predicate)
    if (existing) {return Promise.resolve(existing)}
    return new Promise((resolve, reject) => {
      const inspect = (): void => {
        const value = messages.find(predicate)
        if (value) { clearTimeout(timeout); changed.delete(inspect); resolve(value) }
      }
      const timeout = setTimeout(() => { changed.delete(inspect); reject(new Error('fixture deadline')) }, 3000)
      changed.add(inspect)
    })
  }
  const transport: CodexAppServerTransport = {
    async *read(signal) {
      const abort = (): void => { stdout.destroy() }
      signal.addEventListener('abort', abort, { once: true })
      try {
        for await (const chunk of stdout) {yield chunk as Uint8Array}
      } finally { signal.removeEventListener('abort', abort) }
    },
    async write(frame, signal) {
      writes.push(JSON.parse(frame) as Message)
      if (blocking) {
        const current = blocking
        blocking = undefined
        current.started.release()
        await current.released.promise
      }
      assert.ok(!signal.aborted, 'caller transport refuses writes after close')
      await new Promise<void>((resolve, reject) => { stdin.write(frame, error => error ? reject(error) : resolve()) })
    },
  }
  await waitFor(message => message.event === 'ready')
  return {
    transport, messages, writes, waitFor,
    blockNextWrite() {
      assert.equal(blocking, undefined)
      const blocked = { started: gate(), released: gate() }
      blocking = blocked
      return { started: blocked.started.promise, release: blocked.released.release }
    },
    async command(value: Message) {
      const id = ++nextCommand
      child.send({ ...value, id })
      await waitFor(message => message.commandId === id)
    },
  }
}
