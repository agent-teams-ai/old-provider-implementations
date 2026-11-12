import { executionAssert } from './v2-failures.ts'
import { record } from './v2-projection-helpers.ts'

export interface OpenCodeV2NativeCatalog {
  provider: { id: string; name: string; activation: 'auto' | 'enabled' | 'disabled' } | null
  defaultModel: { providerId: string; modelId: string } | null
  models: { id: string; name: string; enabled: boolean; contextTokens: number | null;
    outputTokens: number | null; inputModalities: readonly string[] }[]
}
function text(value: unknown): string {
  executionAssert(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value),
    'invalid_native_catalog')
  return value
}
const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null

/** Native inventory only. Never returns provider settings, headers, auth values or native paths. */
export async function readOpenCodeV2OwnedCatalog(
  fetcher: (url: string) => Promise<Response>, endpoint: string, directory: string, selectedProvider: string,
): Promise<OpenCodeV2NativeCatalog> {
  text(selectedProvider)
  const query = new URLSearchParams({ 'location[directory]': directory })
  const read = async (route: string) => {
    const value = record(await (await fetcher(endpoint + route + '?' + query)).json() as unknown)
    executionAssert(value !== null && record(value.location)?.directory === directory, 'native_catalog_binding_mismatch')
    return value.data
  }
  // Serial finite reads share the original owner deadline and custody lease.
  const providers = await read('/api/provider'), models = await read('/api/model'), selected = await read('/api/model/default')
  executionAssert(Array.isArray(providers) && providers.length <= 1024 &&
    Array.isArray(models) && models.length <= 4096, 'invalid_native_catalog')
  const providerIds = new Set<string>()
  let provider: OpenCodeV2NativeCatalog['provider'] = null
  for (const raw of providers) {
    const row = record(raw)
    executionAssert(row !== null, 'invalid_native_catalog')
    const id = text(row.id)
    executionAssert(!providerIds.has(id), 'invalid_native_catalog'); providerIds.add(id)
    if (id !== selectedProvider) continue
    executionAssert(row.activation === 'auto' || row.activation === 'enabled' || row.activation === 'disabled', 'invalid_native_catalog')
    provider = { id, name: text(row.name), activation: row.activation }
  }
  const projected: OpenCodeV2NativeCatalog['models'] = [], ids = new Set<string>()
  for (const raw of models) {
    const model = record(raw)
    executionAssert(model !== null, 'invalid_native_catalog')
    if (text(model.providerID) !== selectedProvider) continue
    const id = text(model.id), limits = record(model.limit), capabilities = record(model.capabilities)
    executionAssert(!ids.has(id) && limits !== null && capabilities !== null &&
      typeof model.enabled === 'boolean' && Array.isArray(capabilities.input) && capabilities.input.length <= 16,
    'invalid_native_catalog')
    ids.add(id)
    projected.push({ id, name: text(model.name), enabled: model.enabled,
      contextTokens: positive(limits.context), outputTokens: positive(limits.output),
      inputModalities: (capabilities.input as unknown[]).map(text) })
  }
  const nativeDefault = selected == null ? null : record(selected)
  executionAssert(selected == null || nativeDefault !== null, 'invalid_native_catalog')
  const defaultModel = nativeDefault ? { providerId: text(nativeDefault.providerID), modelId: text(nativeDefault.id) } : null
  const result = { provider, models: projected, defaultModel }
  executionAssert(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024, 'invalid_native_catalog')
  return result
}
