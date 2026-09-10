import { ws } from '@/api/client'
import { createDocumentSession, type OpenDocumentOptions } from './yjsSession'

export { readPeers } from './yjsSession'
export type { AwarenessPeer, OpenDocumentOptions, YDocSession } from './yjsSession'

export function openDocument(opts: OpenDocumentOptions) {
  return createDocumentSession(opts, ws)
}
