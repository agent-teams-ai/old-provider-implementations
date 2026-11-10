export function buildQueryPath(path: string, query: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value.trim().length > 0) {
      params.set(key, value)
    }
  }
  const encoded = params.toString()
  return encoded.length > 0 ? `${path}?${encoded}` : path
}
