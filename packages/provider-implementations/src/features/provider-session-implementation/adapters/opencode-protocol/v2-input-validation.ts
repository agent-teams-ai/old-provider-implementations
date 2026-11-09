import { safeV2MessageID } from './v2-native-identifiers.ts'
import { executionAssert } from './v2-failures.ts'
import { record } from './v2-projection-helpers.ts'
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
    && typeof fields.id === 'string' && safeV2MessageID(fields.id)
    && typeof fields.text === 'string' && fields.text.trim().length > 0 && Buffer.byteLength(fields.text) <= 256 * 1024
    && fields.delivery === 'queue' && typeof fields.resume === 'boolean', 'invalid_input')
  // This TEST-only credential-bearing wire has no effective tool or external-
  // directory permission attestation. File, agent and skill attachments can
  // invoke unqualified native effects; only the private text-only queue path
  // is currently admitted. Refuse even empty arrays until Host qualification.
  executionAssert(fields.files === undefined && fields.agents === undefined
    && fields.skills === undefined, 'capabilities_pending')
}

function executionMethodAllowed(method: string, flags: { session: boolean; list: boolean; log: boolean; scoped: boolean; identity: boolean; create: boolean; prompt: boolean; activation: boolean }): boolean {
  return method === 'GET' && (flags.session || flags.list || flags.log || flags.scoped || flags.identity)
    || method === 'POST' && (flags.create || flags.prompt || flags.activation)
}
export function validateExecutionRoute(request: Request, pin: string, directory: string, endpoint: string, nativeSessionId: string) {
  const url = new URL(request.url)
  executionAssert(url.origin === endpoint && url.username.length === 0 && url.password.length === 0 && url.hash.length === 0, 'authority_mismatch')
  // The private session driver's capability must not apply to another session
  // on the same loopback server. Exact path binding is enforced before credentials.
  const sessionPath = `/api/session/${nativeSessionId}`
  const session = url.pathname === sessionPath, prompt = url.pathname === sessionPath + '/prompt'
  const list = url.pathname === sessionPath + '/inbox' || url.pathname === sessionPath + '/message'
  const log = url.pathname === `/api/experimental/session/${nativeSessionId}/log`
  // Global configuration and integration discovery can expose account details;
  // a session-bound credential wire has no authority to read either endpoint.
  const scoped = /^\/api\/(?:location|agent\/[^/]+|model)$/.test(url.pathname)
  const activation = pin === '2.0.0' && url.pathname === '/api/plugin/await-activation'
  const identity = (pin === '2.0.0' ? ['/api/health', '/api/server'] : ['/api/info']).includes(url.pathname), create = url.pathname === '/api/session'
  // The V2 Session SPI binds an already owned session. Native creation is a separate
  // Host-custody operation: this transport cannot prove effective ordered permissions
  // or prevent V2's default external_directory allow. Deny before any native fetch.
  executionAssert(!create, 'capabilities_pending')
  executionAssert(executionMethodAllowed(request.method, { session, prompt, list, log, scoped, activation, identity, create }), 'capabilities_pending')
  const allowed = scoped || activation ? ['location[directory]'] : log ? ['after', 'follow'] : url.pathname.endsWith('/message') ? ['cursor', 'limit'] : []
  for (const key of url.searchParams.keys()) { executionAssert(allowed.includes(key) && url.searchParams.getAll(key).length === 1, 'authority_mismatch') }
  // These raw GET routes also carry Host credentials. Keep untrusted query
  // values finite before native dispatch, not just the returned byte stream.
  if (list && url.pathname.endsWith('/message')) {
    const limit = url.searchParams.get('limit'), cursor = url.searchParams.get('cursor')
    executionAssert(limit === null || (/^(?:[1-9]|[1-9][0-9]|1[0-9][0-9]|200)$/.test(limit)), 'authority_mismatch')
    executionAssert(cursor === null || (cursor.length > 0 && Buffer.byteLength(cursor) <= 4096), 'authority_mismatch')
  }
  if (log) {
    const after = url.searchParams.get('after')
    executionAssert(after === null || (/^(?:0|[1-9][0-9]*)$/.test(after) && Number.isSafeInteger(Number(after))), 'authority_mismatch')
  }
  if (scoped || activation) { executionAssert(url.searchParams.get('location[directory]') === directory, 'authority_mismatch') }
  if (log) { executionAssert(url.searchParams.get('follow') === 'false', 'capabilities_pending') }
  return { url, session, log, activation, create, prompt }
}
