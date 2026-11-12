import { executionAssert } from './v2-failures.ts'
import { record } from './v2-projection-helpers.ts'
import { catalogText, projectOpenCodeV2Model, projectOpenCodeV2Provider,
  readOpenCodeV2CatalogData } from './v2-owned-catalog.ts'

/** Four finite native GETs, with no per-provider model rereads, prompts or credential mutation. */
export async function readOpenCodeV2OwnedDirectory(
  fetcher: (url: string) => Promise<Response>, endpoint: string, directory: string,
) {
  const source = await readOpenCodeV2CatalogData(fetcher, endpoint, directory)
  const providers = source.providers.map(projectOpenCodeV2Provider)
  executionAssert(new Set(providers.map(row => row.id)).size === providers.length, 'invalid_native_catalog')
  const modelIds = new Set<string>()
  const models = source.models.map(raw => {
    const row = record(raw)
    executionAssert(row !== null, 'invalid_native_catalog')
    const providerId = catalogText(row.providerID), model = projectOpenCodeV2Model(row)
    const identity = JSON.stringify([providerId, model.id])
    executionAssert(!modelIds.has(identity), 'invalid_native_catalog'); modelIds.add(identity)
    // Directory consumers need inventory, never variant settings. The
    // selected-model read retains the validated variant IDs for admission.
    const { variants: _variants, ...selected } = model
    return { providerId, ...selected }
  })
  const rawIntegrations = await source.read('/api/integration')
  executionAssert(Array.isArray(rawIntegrations) && rawIntegrations.length <= 1024, 'invalid_native_catalog')
  const integrations = rawIntegrations.map(raw => {
    const row = record(raw)
    executionAssert(row !== null && Array.isArray(row.methods) && row.methods.length <= 256, 'invalid_native_catalog')
    let plainKey = false
    for (const rawMethod of row.methods) {
      const method = record(rawMethod)
      executionAssert(method !== null && typeof method.type === 'string' &&
        ['key', 'oauth', 'external', 'command', 'env'].includes(method.type), 'invalid_native_catalog')
      if (method.type === 'key' && method.form === undefined) plainKey = true
    }
    // No connections, labels, environment names, URLs, forms or native credentials.
    return { id: catalogText(row.id), name: catalogText(row.name), plainKey }
  })
  executionAssert(new Set(integrations.map(row => row.id)).size === integrations.length, 'invalid_native_catalog')
  const result = { providers, models, integrations, defaultModel: source.defaultModel }
  executionAssert(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024, 'invalid_native_catalog')
  return result
}
