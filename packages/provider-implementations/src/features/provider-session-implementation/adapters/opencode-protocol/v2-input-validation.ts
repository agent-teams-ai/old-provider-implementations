import { executionAssert } from './v2-failures.ts'
import { record } from './v2-projection-helpers.ts'
function validateMention(value: unknown, textLength: number): void {
  const mention = record(value)
  executionAssert(mention !== null && Object.keys(mention).toSorted().join(',') === 'end,start,text'
    && Number.isSafeInteger(mention.start) && Number.isSafeInteger(mention.end)
    && (mention.start as number) >= 0 && (mention.end as number) >= (mention.start as number)
    && (mention.end as number) <= textLength && typeof mention.text === 'string', 'invalid_input')
}
function validateAttachment(value: unknown, key: string, textLength: number): void {
  const attachment = record(value)
  executionAssert(attachment !== null, 'invalid_input')
  const required = key === 'files' ? 'uri' : key === 'agents' ? 'name' : 'id'
  const names = key === 'files' ? ['uri', 'name', 'description', 'mention'] : [required, 'mention']
  executionAssert(Object.keys(attachment).every(name => names.includes(name))
    && typeof attachment[required] === 'string' && attachment[required].length > 0 && attachment[required].length <= 4096, 'invalid_input')
  for (const optional of ['name', 'description']) {
    if (attachment[optional] !== undefined) { executionAssert(typeof attachment[optional] === 'string' && attachment[optional].length <= 4096, 'invalid_input') }
  }
  if (attachment.mention !== undefined) { validateMention(attachment.mention, textLength) }
}
export function validateExecutionBody(parsed: unknown, create: boolean, directory: string): void {
  executionAssert(typeof parsed === 'object' && parsed !== null)
  if (create) {
    executionAssert('location' in parsed)
    const location = record(parsed.location)
    executionAssert(location !== null && location.directory === directory, 'authority_mismatch')
    return
  }
  const fields = parsed as Record<string, unknown>
  executionAssert(Object.keys(fields).every(key => ['id', 'text', 'files', 'agents', 'skills', 'delivery', 'resume'].includes(key))
    && typeof fields.id === 'string' && /^msg_[A-Za-z0-9]+$/.test(fields.id)
    && typeof fields.text === 'string' && fields.text.trim().length > 0 && Buffer.byteLength(fields.text) <= 256 * 1024
    && fields.delivery === 'queue' && typeof fields.resume === 'boolean', 'invalid_input')
  for (const key of ['files', 'agents', 'skills']) {
    const values = fields[key]
    if (values === undefined) { continue }
    executionAssert(Array.isArray(values) && values.length <= 256, 'invalid_input')
    for (const value of values) { validateAttachment(value, key, fields.text.length) }
  }
}

function executionMethodAllowed(method: string, flags: { session: boolean; list: boolean; log: boolean; scoped: boolean; identity: boolean; create: boolean; prompt: boolean; activation: boolean }): boolean {
  return method === 'GET' && (flags.session || flags.list || flags.log || flags.scoped || flags.identity)
    || method === 'POST' && (flags.create || flags.prompt || flags.activation)
}
export function validateExecutionRoute(request: Request, pin: string, directory: string, endpoint: string) {
  const url = new URL(request.url)
  executionAssert(url.origin === endpoint && url.username.length === 0 && url.password.length === 0 && url.hash.length === 0, 'authority_mismatch')
  const session = /^\/api\/session\/[^/]+$/.test(url.pathname), prompt = /^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)
  const list = /^\/api\/session\/[^/]+\/(?:inbox|message)$/.test(url.pathname), log = /^\/api\/experimental\/session\/[^/]+\/log$/.test(url.pathname)
  const scoped = /^\/api\/(?:location|agent\/[^/]+|model|integration|config)$/.test(url.pathname)
  const activation = pin === '2.0.0' && url.pathname === '/api/plugin/await-activation'
  const identity = (pin === '2.0.0' ? ['/api/health', '/api/server'] : ['/api/info']).includes(url.pathname), create = url.pathname === '/api/session'
  executionAssert(executionMethodAllowed(request.method, { session, prompt, list, log, scoped, activation, identity, create }), 'capabilities_pending')
  const allowed = scoped || activation ? ['location[directory]'] : log ? ['after', 'follow'] : url.pathname.endsWith('/message') ? ['cursor', 'limit'] : []
  for (const key of url.searchParams.keys()) { executionAssert(allowed.includes(key) && url.searchParams.getAll(key).length === 1, 'authority_mismatch') }
  if (scoped || activation) { executionAssert(url.searchParams.get('location[directory]') === directory, 'authority_mismatch') }
  if (log) { executionAssert(url.searchParams.get('follow') === 'false', 'capabilities_pending') }
  return { url, session, log, activation, create, prompt }
}
