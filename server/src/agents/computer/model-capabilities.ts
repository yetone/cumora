import type { EngineId } from './engine.js'
import type { EngineModelCatalog } from './model-catalog.js'

/** A model capability is deliberately tri-state. An absent provider claim is
 * not evidence that an image can be read, and it is not evidence that it
 * cannot. Callers must surface the unknown state instead of silently dropping
 * an image or pretending it was understood. */
export type VisionCapability = 'supported' | 'unsupported' | 'unknown'

export interface EngineCapabilities {
  engine: EngineId
  /** Secure engines keep model file access inside the approved agent home.
   * Compatibility engines are opt-in and retain their existing host policy. */
  filesystem: 'sandboxed' | 'compatibility'
  /** The daemon can materialize chat attachments into the agent home for every
   * engine, so attachment access does not depend on host-home permissions. */
  attachmentAccess: 'daemon-cache'
  vision: VisionCapability
}

export function visionCapabilityForModel(
  catalog: Pick<EngineModelCatalog, 'models'> | null | undefined,
  modelId: string | null | undefined,
): VisionCapability {
  if (!catalog || !modelId) return 'unknown'
  return catalog.models.find((model) => model.id === modelId)?.vision ?? 'unknown'
}

export function engineCapabilities(
  engine: EngineId,
  opts: { unsandboxed?: boolean; vision?: VisionCapability } = {},
): EngineCapabilities {
  return {
    engine,
    filesystem: opts.unsandboxed ? 'compatibility' : 'sandboxed',
    attachmentAccess: 'daemon-cache',
    vision: opts.vision ?? 'unknown',
  }
}
