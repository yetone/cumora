import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  engineCapabilities,
  visionCapabilityForModel,
  type VisionCapability,
} from '../agents/computer/model-capabilities.js'

test('missing or untrusted model capability remains unknown', () => {
  assert.equal(visionCapabilityForModel({ models: [{ id: 'custom', label: 'custom' }] }, 'custom'), 'unknown')
  assert.equal(visionCapabilityForModel(null, 'custom'), 'unknown')
  assert.equal(visionCapabilityForModel({ models: [{ id: 'custom', label: 'custom', vision: 'unsupported' }] }, 'custom'), 'unsupported')
})

test('explicit model capability wins without guessing from the vendor name', () => {
  const capabilities: VisionCapability[] = ['supported', 'unsupported', 'unknown']
  for (const vision of capabilities) {
    assert.equal(visionCapabilityForModel({ models: [{ id: 'gpt-vision', label: 'gpt-vision', vision }] }, 'gpt-vision'), vision)
  }
  assert.equal(visionCapabilityForModel({ models: [{ id: 'gpt-vision', label: 'gpt-vision' }] }, 'gpt-vision'), 'unknown')
})

test('attachment access is daemon-mediated in both filesystem modes', () => {
  assert.deepEqual(engineCapabilities('claude'), {
    engine: 'claude', filesystem: 'sandboxed', attachmentAccess: 'daemon-cache', vision: 'unknown',
  })
  assert.deepEqual(engineCapabilities('cursor', { unsandboxed: true, vision: 'supported' }), {
    engine: 'cursor', filesystem: 'compatibility', attachmentAccess: 'daemon-cache', vision: 'supported',
  })
})
