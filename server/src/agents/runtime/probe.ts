/**
 * Tiny dev helper — mint a runtime JWT for an agent and print it +
 * the company id. Used to drive a manual HTTP-mode turn-worker run
 * for smoke-testing the /runtime/* endpoints.
 *
 *   tsx server/src/agents/runtime/probe.ts <agentId>
 *
 * Prints two lines to stdout:
 *   COMPANY=<companyId>
 *   TOKEN=<jwt>
 */
import { pool } from '../../db/pool.js'
import { signAgentToken } from './jwt.js'

async function main(): Promise<void> {
  const agentId = process.argv[2]
  if (!agentId) {
    console.error('usage: tsx server/src/agents/runtime/probe.ts <agentId>')
    process.exit(2)
  }
  const { rows } = await pool.query<{
    id: string
    company_id: string | null
    computer_id: string | null
    runtime_assignment_id: string
  }>(
    'SELECT id, company_id, computer_id, runtime_assignment_id FROM participants WHERE id = $1',
    [agentId],
  )
  if (rows.length === 0) {
    console.error(`agent ${agentId} not found`)
    process.exit(1)
  }
  const companyId = rows[0].company_id
  const token = signAgentToken({
    agentId,
    companyId,
    computerId: rows[0].computer_id,
    assignmentId: rows[0].runtime_assignment_id,
  })
  console.log(`COMPANY=${companyId ?? ''}`)
  console.log(`TOKEN=${token}`)
  await pool.end()
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
