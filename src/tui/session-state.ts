import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { resolveDshHome } from '../shared/paths.js'

export interface PersistedTextAttachment {
  kind: 'text'
  placeholder: string
  text: string
}

export interface PersistedSessionUiState {
  draft: string
  approvalMode: 'ask' | 'auto'
  attachments: PersistedTextAttachment[]
  updatedAt: number
}

interface StateFile {
  version: 1
  sessions: Record<string, PersistedSessionUiState>
}

export function defaultSessionStatePath(): string {
  return join(resolveDshHome(), 'state', 'dshell-tui.json')
}

function validEntry(value: unknown): PersistedSessionUiState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (typeof row.draft !== 'string' || (row.approvalMode !== 'ask' && row.approvalMode !== 'auto')) return undefined
  const attachments = Array.isArray(row.attachments)
    ? row.attachments.flatMap((item): PersistedTextAttachment[] => {
        if (typeof item !== 'object' || item === null) return []
        const attachment = item as Record<string, unknown>
        return attachment.kind === 'text' && typeof attachment.placeholder === 'string' && typeof attachment.text === 'string'
          ? [{ kind: 'text', placeholder: attachment.placeholder, text: attachment.text }]
          : []
      })
    : []
  return {
    draft: row.draft,
    approvalMode: row.approvalMode,
    attachments,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
  }
}

/** Small atomic state file owned by dshell, independent of Harness storage. */
export class SessionStateStore {
  private readonly sessions = new Map<string, PersistedSessionUiState>()
  private dirty = false

  private constructor(readonly path?: string) {}

  static async open(path?: string): Promise<SessionStateStore> {
    const store = new SessionStateStore(path)
    if (path === undefined) return store
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<StateFile>
      if (parsed.version !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) return store
      for (const [sessionId, value] of Object.entries(parsed.sessions)) {
        const entry = validEntry(value)
        if (entry !== undefined) store.sessions.set(sessionId, entry)
      }
    } catch {
      // Missing, partial, or old state must never block the terminal.
    }
    return store
  }

  get(sessionId: string): PersistedSessionUiState | undefined {
    const entry = this.sessions.get(sessionId)
    return entry === undefined ? undefined : { ...entry, attachments: entry.attachments.map(item => ({ ...item })) }
  }

  set(sessionId: string, state: Omit<PersistedSessionUiState, 'updatedAt'>): void {
    const next: PersistedSessionUiState = { ...state, attachments: state.attachments.map(item => ({ ...item })), updatedAt: Date.now() }
    const previous = this.sessions.get(sessionId)
    if (previous !== undefined
      && previous.draft === next.draft
      && previous.approvalMode === next.approvalMode
      && JSON.stringify(previous.attachments) === JSON.stringify(next.attachments)) return
    this.sessions.set(sessionId, next)
    this.dirty = true
  }

  async flush(): Promise<void> {
    if (!this.dirty || this.path === undefined) return
    this.dirty = false
    const sessions = Object.fromEntries([...this.sessions.entries()]
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, 500))
    const body = JSON.stringify({ version: 1, sessions } satisfies StateFile, null, 2) + '\n'
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    try {
      await writeFile(temporary, body, { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.path)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
}
