import { types as nodeUtilTypes } from 'node:util'

function assertCanonical(value: boolean): asserts value { if (!value) {throw new Error('invalid_native_json')} }
function canonicalRecord(value: unknown): Record<string, unknown> {
  assertCanonical(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
export function canonicalExecutionJSON(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {return JSON.stringify(value)}
  if (typeof value === 'number') { assertCanonical(Number.isFinite(value)); return JSON.stringify(value) }
  if (Array.isArray(value)) {
    // Only plain, dense JSON-data slots may become durable native instructions.
    // Sparse slots, custom map(), inherited methods, accessors and Proxies
    // must not silently rewrite a Host-supplied instruction before native PUT.
    assertCanonical(!nodeUtilTypes.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype)
    assertCanonical(Reflect.ownKeys(value).length === value.length + 1)
    const items: string[] = []
    for (let index = 0; index < value.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index))
      assertCanonical(entry !== undefined && entry.enumerable === true && 'value' in entry)
      items.push(canonicalExecutionJSON(entry.value))
    }
    return '[' + items.join(',') + ']'
  }
  const object = canonicalRecord(value)
  assertCanonical(Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null)
  return '{' + Object.keys(object).toSorted().map(key => JSON.stringify(key) + ':' + canonicalExecutionJSON(object[key])).join(',') + '}'
}
