import { parseArgs } from '../cli-parse.js'
import { LocalProjectStore, type LocalProjectGrant } from './local-project-store.js'
import { LocalProjects } from './local-projects.js'
import {
  type HandoffRecord,
  LocalWorktreeError,
  LocalWorktreeManager,
  type WorktreeLease,
} from './local-worktrees.js'

export interface LocalCollaborationOptions {
  homeRoot: string
  projectStore?: LocalProjectStore
  worktreeStorePath?: string
  patchRoot?: string
}

export interface LocalCommandContext {
  /** Present only for commands arriving through an Agent's daemon broker. */
  agentId?: string
}

export interface LocalCommandResult {
  text: string
  exitCode: number
}

const MAX_DIFF_OUTPUT_BYTES = 1024 * 1024

function usage(): string {
  return [
    'cumora agent computer local — local-only project collaboration',
    '',
    'Repository paths, branches, commits, patches, and worktrees stay on this Computer.',
    '',
    'Human setup:',
    '  cumora agent computer local projects grant <absolute-path> [--project <opaque-id>]',
    '  cumora agent computer local projects list [--json]',
    '  cumora agent computer local projects revoke <id>',
    '',
    'Agent or local operator:',
    '  cumora agent computer local worktree create <project-id> <task-id> [--agent <id>] [--base <commit>] [--branch <name>] [--json]',
    '  cumora agent computer local worktree list [--project <id>] [--task <id>] [--json]',
    '  cumora agent computer local worktree show <lease-id> [--json]',
    '  cumora agent computer local worktree status <lease-id> [--json]',
    '  cumora agent computer local worktree diff <lease-id> [--json]',
    '  cumora agent computer local worktree commit <lease-id> --expected-head <commit> --message <text> [--json]',
    '  cumora agent computer local handoff propose <lease-id> <to-agent-id> [--json]',
    '  cumora agent computer local handoff list [--task <id>] [--json]',
    '  cumora agent computer local handoff show <handoff-id> [--diff] [--json]',
    '  cumora agent computer local handoff accept <handoff-id> [--json]',
    '  cumora agent computer local handoff reject <handoff-id> [--json]',
    '',
    'Inside a running Agent, the daemon supplies the caller identity. The receiver accepts a handoff itself.',
  ].join('\n')
}

function json(value: unknown): string { return JSON.stringify(value, null, 2) }

function boolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true'
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`)
  return value
}

function leaseLine(lease: WorktreeLease): string {
  return `${lease.id}  ${lease.repositoryId}/${lease.taskId}  ${lease.agentId}  ${lease.state}  ${lease.dirty ? 'dirty' : 'clean'}  ${lease.headCommit.slice(0, 12)}  ${lease.path}`
}

function handoffLine(handoff: HandoffRecord): string {
  return `${handoff.id}  ${handoff.taskId}  ${handoff.fromAgentId} → ${handoff.toAgentId}  ${handoff.state}  ${handoff.sourceHeadCommit.slice(0, 12)}`
}

/** Local command coordinator. It has no server client and performs no uploads. */
export class LocalCollaboration {
  private readonly projects: LocalProjects

  constructor(private readonly options: LocalCollaborationOptions) {
    this.projects = new LocalProjects(options.projectStore ?? new LocalProjectStore())
  }

  async run(argv: string[], context: LocalCommandContext = {}): Promise<LocalCommandResult> {
    try {
      if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
        return { text: usage(), exitCode: 0 }
      }
      if (argv[0] === 'projects') return await this.projectsCommand(argv.slice(1), context)
      if (argv[0] === 'worktree') return await this.worktreeCommand(argv.slice(1), context)
      if (argv[0] === 'handoff') return await this.handoffCommand(argv.slice(1), context)
      throw new Error(`unknown local command: ${argv[0]}\n\n${usage()}`)
    } catch (error) {
      return { text: `local collaboration: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }
    }
  }

  private async projectsCommand(argv: string[], context: LocalCommandContext): Promise<LocalCommandResult> {
    const parsed = parseArgs(argv)
    const op = parsed.positional[0] ?? 'list'
    if (context.agentId) throw new Error('agents cannot grant, list, or revoke host repository access; ask the operator to run this from the Computer terminal')
    if (op === 'grant') {
      const project = await this.projects.grant(required(parsed.positional[1], 'absolute repository path'), {
        cloudProjectId: stringFlag(parsed.flags, 'project') ?? null,
      })
      return { text: boolFlag(parsed.flags, 'json') ? json(project) : `granted ${project.id}: ${project.topLevel}`, exitCode: 0 }
    }
    if (op === 'list') {
      const rows = await this.projects.list()
      return { text: boolFlag(parsed.flags, 'json') ? json(rows) : rows.length ? rows.map((row) => `${row.id}  ${row.cloudProjectId ?? '-'}  ${row.topLevel}`).join('\n') : 'no local projects granted', exitCode: 0 }
    }
    if (op === 'revoke') {
      const id = required(parsed.positional[1], 'project id')
      const removed = await this.projects.revoke(id)
      return { text: removed ? `revoked ${id}` : `no project ${id}`, exitCode: removed ? 0 : 1 }
    }
    throw new Error('usage: projects <grant|list|revoke> ...')
  }

  private async worktreeCommand(argv: string[], context: LocalCommandContext): Promise<LocalCommandResult> {
    const parsed = parseArgs(argv)
    const op = parsed.positional[0] ?? 'list'
    if (op === 'create') {
      const project = await this.requireProject(parsed.positional[1])
      const taskId = required(parsed.positional[2], 'task id')
      const requestedAgent = stringFlag(parsed.flags, 'agent')
      const agentId = context.agentId ?? requestedAgent
      if (!agentId) throw new Error('agent id is required (--agent outside a running Agent)')
      if (context.agentId && requestedAgent && requestedAgent !== context.agentId) throw new Error('an Agent can only create its own worktree')
      const lease = await this.manager(project).create(taskId, agentId, {
        baseCommit: stringFlag(parsed.flags, 'base'),
        branch: stringFlag(parsed.flags, 'branch'),
      })
      return { text: boolFlag(parsed.flags, 'json') ? json(lease) : leaseLine(lease), exitCode: 0 }
    }
    if (op === 'list') {
      const projectId = stringFlag(parsed.flags, 'project')
      const taskId = stringFlag(parsed.flags, 'task')
      const projects = projectId ? [await this.requireProject(projectId)] : await this.projects.list()
      const rows: WorktreeLease[] = []
      for (const project of projects) rows.push(...await this.manager(project).listLeases())
      const visible = rows.filter((lease) => (!context.agentId || lease.agentId === context.agentId) && (!taskId || lease.taskId === taskId))
      return { text: boolFlag(parsed.flags, 'json') ? json(visible) : visible.length ? visible.map(leaseLine).join('\n') : 'no local worktrees', exitCode: 0 }
    }
    if (op === 'show') {
      const found = await this.findLease(required(parsed.positional[1], 'worktree id'), context)
      const lease = await this.manager(found.project).snapshot(found.lease.id)
      return { text: boolFlag(parsed.flags, 'json') ? json(lease) : leaseLine(lease), exitCode: 0 }
    }
    if (op === 'status') {
      const found = await this.findLease(required(parsed.positional[1], 'worktree id'), context)
      const status = await this.manager(found.project).status(found.lease.id)
      const output = { lease: status.lease, status: status.text }
      return { text: boolFlag(parsed.flags, 'json') ? json(output) : `${leaseLine(status.lease)}\n${status.text || 'clean'}`, exitCode: 0 }
    }
    if (op === 'diff') {
      const found = await this.findLease(required(parsed.positional[1], 'worktree id'), context)
      const bytes = await this.manager(found.project).diff(found.lease.id)
      const truncated = bytes.length > MAX_DIFF_OUTPUT_BYTES
      const diff = bytes.subarray(0, MAX_DIFF_OUTPUT_BYTES).toString('utf8')
      return { text: boolFlag(parsed.flags, 'json')
        ? json({ diff, diffTruncated: truncated, diffBytes: bytes.length })
        : `${diff}${truncated ? `\n[diff truncated at ${MAX_DIFF_OUTPUT_BYTES} of ${bytes.length} bytes]` : ''}`, exitCode: 0 }
    }
    if (op === 'commit') {
      const found = await this.findLease(required(parsed.positional[1], 'worktree id'), context)
      const expectedHead = required(stringFlag(parsed.flags, 'expected-head'), 'expected head')
      const message = required(stringFlag(parsed.flags, 'message'), 'commit message')
      const lease = await this.manager(found.project).commit(found.lease.id, message, expectedHead)
      return { text: boolFlag(parsed.flags, 'json') ? json(lease) : leaseLine(lease), exitCode: 0 }
    }
    throw new Error('usage: worktree <create|list|show|status|diff|commit> ...')
  }

  private async handoffCommand(argv: string[], context: LocalCommandContext): Promise<LocalCommandResult> {
    const parsed = parseArgs(argv)
    const op = parsed.positional[0] ?? 'list'
    if (op === 'propose') {
      const found = await this.findLease(required(parsed.positional[1], 'source worktree id'), context)
      if (context.agentId && found.lease.agentId !== context.agentId) throw new Error('an Agent can only hand off its own worktree')
      const handoff = await this.manager(found.project).proposeHandoff(found.lease.id, required(parsed.positional[2], 'target agent id'))
      return { text: boolFlag(parsed.flags, 'json') ? json(handoff) : handoffLine(handoff), exitCode: 0 }
    }
    if (op === 'list') {
      const taskId = stringFlag(parsed.flags, 'task')
      const rows: HandoffRecord[] = []
      for (const project of await this.projects.list()) rows.push(...await this.manager(project).listHandoffs())
      const visible = rows.filter((handoff) => (!context.agentId || handoff.fromAgentId === context.agentId || handoff.toAgentId === context.agentId) && (!taskId || handoff.taskId === taskId))
      return { text: boolFlag(parsed.flags, 'json') ? json(visible) : visible.length ? visible.map(handoffLine).join('\n') : 'no local handoffs', exitCode: 0 }
    }
    if (op === 'show') {
      const found = await this.findHandoff(required(parsed.positional[1], 'handoff id'), context)
      if (!boolFlag(parsed.flags, 'diff')) return { text: boolFlag(parsed.flags, 'json') ? json(found.handoff) : handoffLine(found.handoff), exitCode: 0 }
      const bytes = await this.manager(found.project).readHandoffPatch(found.handoff.id)
      const truncated = bytes.length > MAX_DIFF_OUTPUT_BYTES
      const diff = bytes.subarray(0, MAX_DIFF_OUTPUT_BYTES).toString('utf8')
      return { text: boolFlag(parsed.flags, 'json')
        ? json({ ...found.handoff, diff, diffTruncated: truncated, diffBytes: bytes.length })
        : `${handoffLine(found.handoff)}\n\n${diff}${truncated ? `\n\n[diff truncated at ${MAX_DIFF_OUTPUT_BYTES} of ${bytes.length} bytes]` : ''}`, exitCode: 0 }
    }
    if (op === 'accept') {
      const found = await this.findHandoff(required(parsed.positional[1], 'handoff id'), context)
      if (context.agentId && found.handoff.toAgentId !== context.agentId) throw new Error('only the target Agent can accept this handoff')
      const accepted = await this.manager(found.project).acceptHandoff(found.handoff.id)
      const output = { handoff: accepted.handoff, worktree: accepted.lease }
      return { text: boolFlag(parsed.flags, 'json') ? json(output) : `${handoffLine(output.handoff)}\n${leaseLine(output.worktree)}`, exitCode: 0 }
    }
    if (op === 'reject') {
      const found = await this.findHandoff(required(parsed.positional[1], 'handoff id'), context)
      if (context.agentId && found.handoff.toAgentId !== context.agentId) throw new Error('only the target Agent can reject this handoff')
      const rejected = await this.manager(found.project).rejectHandoff(found.handoff.id)
      return { text: boolFlag(parsed.flags, 'json') ? json(rejected) : handoffLine(rejected), exitCode: 0 }
    }
    throw new Error('usage: handoff <propose|list|show|accept|reject> ...')
  }

  private manager(project: LocalProjectGrant): LocalWorktreeManager {
    return new LocalWorktreeManager(project, {
      homeRoot: this.options.homeRoot,
      storePath: this.options.worktreeStorePath,
      patchRoot: this.options.patchRoot,
    })
  }

  private async requireProject(id: string | undefined): Promise<LocalProjectGrant> {
    if (!id) throw new Error('project id is required')
    const project = (await this.projects.list()).find((row) => row.id === id)
    if (!project) throw new Error(`local project ${id} was not found`)
    return project
  }

  private async findLease(id: string, context: LocalCommandContext): Promise<{ project: LocalProjectGrant; lease: WorktreeLease }> {
    for (const project of await this.projects.list()) {
      const lease = (await this.manager(project).listLeases()).find((row) => row.id === id)
      if (lease) {
        if (context.agentId && lease.agentId !== context.agentId) throw new Error('this worktree belongs to another Agent')
        return { project, lease }
      }
    }
    throw new LocalWorktreeError('not-found', `worktree ${id} was not found in a local project`)
  }

  private async findHandoff(id: string, context: LocalCommandContext): Promise<{ project: LocalProjectGrant; handoff: HandoffRecord }> {
    for (const project of await this.projects.list()) {
      const handoff = (await this.manager(project).listHandoffs()).find((row) => row.id === id)
      if (handoff) {
        if (context.agentId && handoff.fromAgentId !== context.agentId && handoff.toAgentId !== context.agentId) throw new Error('this handoff does not involve the current Agent')
        return { project, handoff }
      }
    }
    throw new LocalWorktreeError('not-found', `handoff ${id} was not found in a local project`)
  }
}
