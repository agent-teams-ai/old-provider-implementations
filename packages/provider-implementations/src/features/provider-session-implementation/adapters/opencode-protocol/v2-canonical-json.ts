function assertCanonical(value: boolean): asserts value { if (!value) {throw new Error('invalid_native_json')} }
function canonicalRecord(value: unknown): Record<string, unknown> {
  assertCanonical(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
export function canonicalExecutionJSON(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {return JSON.stringify(value)}
  if (typeof value === 'number') { assertCanonical(Number.isFinite(value)); return JSON.stringify(value) }
  if (Array.isArray(value)) {
    // Sparse arrays are not native JSON. Array(1) previously serialized as
    // [] and could silently persist different instructions after a valid PUT.
    assertCanonical(Object.keys(value).length === value.length)
    for (let index = 0; index < value.length; index++) {
      assertCanonical(Object.hasOwn(value, index))
    }
    return '[' + value.map(canonicalExecutionJSON).join(',') + ']'
  }
  const object = canonicalRecord(value)
  assertCanonical(Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null)
  return '{' + Object.keys(object).toSorted().map(key => JSON.stringify(key) + ':' + canonicalExecutionJSON(object[key])).join(',') + '}'
}
