import { types as nodeUtilTypes } from 'node:util'

function assertCanonical(value: boolean): asserts value { if (!value) {throw new Error('invalid_native_json')} }
function canonicalRecord(value: unknown): Record<string, unknown> {
  assertCanonical(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
/**
 * Serialize only canonical JSON data without invoking Host getters or toJSON.
 * Charge the actual escaped UTF-8 bytes as they are produced: an oversized or
 * cyclic instruction must fail before allocating an unbounded native PUT body.
 */
export function canonicalExecutionJSON(value: unknown, maxBytes = Number.POSITIVE_INFINITY): string {
  // The same canonical serializer serves unbounded, already-validated native
  // event/log readbacks as well as Host-supplied durable instruction writes.
  // A 256 KiB mutation cap must never truncate a valid 4096-event readback.
  const bounded = Number.isFinite(maxBytes)
  let remaining = maxBytes
  const charge = (fragment: string): string => {
    if (bounded) {
      remaining -= Buffer.byteLength(fragment)
      assertCanonical(remaining >= 0)
    }
    return fragment
  }
  const visit = (current: unknown, depth: number): string => {
    if (bounded) assertCanonical(depth <= 32)
    if (current === null || typeof current === 'boolean') return charge(JSON.stringify(current))
    if (typeof current === 'number') {
      assertCanonical(Number.isFinite(current))
      return charge(JSON.stringify(current))
    }
    if (typeof current === 'string') {
      // JSON.stringify may expand control characters sixfold, but never
      // materialize an already oversized source string.
      if (bounded) assertCanonical(Buffer.byteLength(current) <= remaining)
      return charge(JSON.stringify(current))
    }
    if (Array.isArray(current)) {
      assertCanonical((!bounded || depth < 32) && !nodeUtilTypes.isProxy(current) && Object.getPrototypeOf(current) === Array.prototype)
      assertCanonical(Reflect.ownKeys(current).length === current.length + 1)
      charge('[')
      const items: string[] = []
      for (let index = 0; index < current.length; index++) {
        const entry = Object.getOwnPropertyDescriptor(current, String(index))
        assertCanonical(entry !== undefined && entry.enumerable === true && 'value' in entry)
        if (index > 0) charge(',')
        items.push(visit(entry.value, depth + 1))
      }
      charge(']')
      return '[' + items.join(',') + ']'
    }
    const object = canonicalRecord(current)
    assertCanonical((!bounded || depth < 32) && !nodeUtilTypes.isProxy(object)
      && (Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null))
    const keys = Reflect.ownKeys(object)
    assertCanonical(keys.every(key => typeof key === 'string'))
    charge('{')
    const entries = (keys as string[]).toSorted().map((key, index) => {
      const entry = Object.getOwnPropertyDescriptor(object, key)
      assertCanonical(entry !== undefined && entry.enumerable === true && 'value' in entry)
      if (index > 0) charge(',')
      const serializedKey = JSON.stringify(key)
      charge(serializedKey); charge(':')
      return serializedKey + ':' + visit(entry.value, depth + 1)
    })
    charge('}')
    return '{' + entries.join(',') + '}'
  }
  return visit(value, 0)
}
