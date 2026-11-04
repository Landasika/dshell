// Derived from tests/plugin-host.test.mjs at 9205877.
// Simulates DSH services; this is not a real DeepSeek Harness Host.

function createFakeCtx(services = {}) {
  const agents = new Map()
  const sessions = new Map() // sessionId -> { header, events, live, persisted }
  const workspaces = new Map() // path -> workspace record
  const listeners = new Map()
  const disposers = []
  let workspaceSeq = 0

  const recordOf = (sessionId) => sessions.get(sessionId)
  const units = new Map()
  const makeHandle = (sessionId) => {
    let agent = agents.get(sessionId)
    if (agent === undefined) {
      const unit = makeAgent(sessionId)
      agents.set(sessionId, unit.agent)
      units.set(sessionId, unit)
      agent = unit.agent
    }
    return {
      agent,
      dispose: async () => {
        handles.delete(sessionId)
      },
    }
  }
  const handles = new Map()

  const ctx = {
    agents: {
      get: (sessionId) => agents.get(sessionId),
      list: () => [...agents.values()],
      resume: async ({ resumeSessionId }) => {
        const handle = makeHandle(resumeSessionId)
        handles.set(resumeSessionId, handle)
        return handle
      },
      create: async ({ sessionId, meta }) => {
        sessions.set(sessionId, {
          header: { id: sessionId, cwd: meta?.cwd ?? '/work', createdAt: Date.now() },
          events: [],
          live: true,
          persisted: true,
        })
        const handle = makeHandle(sessionId)
        handles.set(sessionId, handle)
        return handle
      },
    },
    sessions: {},
    sessionQuery: {
      listSessions: async () => [...sessions.values()],
      readSession: async (sessionId) => {
        const record = sessions.get(sessionId)
        if (record === undefined) throw Object.assign(new Error(`session ${sessionId} not found`), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return { session: record.header, events: [...record.events] }
      },
      observeSession: async () => ({
        projections: { values: {} },
        [Symbol.dispose]() {},
      }),
    },
    workspaceRegistry: {
      list: () => [...workspaces.values()],
      get: (id) => [...workspaces.values()].find((workspace) => workspace.id === id),
      create: async (path, title) => {
        workspaceSeq += 1
        const workspace = {
          id: `workspace:${path}`,
          path,
          title: title ?? path,
          sessionIds: [],
          attachSession: async (sessionId) => {
            workspace.sessionIds.push(sessionId)
          },
        }
        workspaces.set(path, workspace)
        return workspace
      },
    },
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
      }
    },
    effect: (setup) => {
      const off = setup()
      if (off !== undefined) disposers.push(off)
    },
    get: (name) => services[name],
    ...services,
  }
  /** Invoke the listeners the plugin registered, like DSH waterfalls would. */
  const emit = (event, ...args) => Promise.all(
    (listeners.get(event) ?? []).map((listener) => listener(...args)),
  )
  return { ctx, agents, sessions, workspaces, listeners, disposers, emit, handles, recordOf, units, services }
}

/** An agent with a real, manipulable inbox — enough for queue commands. */
function makeAgent(sessionId) {
  const state = { cancelled: 0 }
  const sent = []
  const sentMessages = []
  const inbox = {
    nextTurn: [],
    nextStep: [],
    remove(requestId) {
      this.nextTurn = this.nextTurn.filter((message) => message.id !== requestId)
      this.nextStep = this.nextStep.filter((message) => message.id !== requestId)
    },
    replace(requestId, message) {
      const swap = (list) => list.map((item) => (item.id === requestId ? message : item))
      this.nextTurn = swap(this.nextTurn)
      this.nextStep = swap(this.nextStep)
    },
  }
  const record = (mode) => (message) => {
    sent.push({ mode, text: message.content?.[0]?.text ?? '' })
    sentMessages.push({ mode, message })
  }
  const agent = {
    id: sessionId,
    session: { id: sessionId },
    inbox,
    followup: record('followup'),
    steer: record('steer'),
    cancel() {
      state.cancelled += 1
    },
  }
  return { agent, state, inbox, sent, sentMessages }
}

function makeSession(harness, sessionId, events = [], header = {}) {
  harness.sessions.set(sessionId, {
    header: { id: sessionId, cwd: '/work', createdAt: 1_000, ...header },
    events,
    live: true,
    persisted: true,
  })
  return harness.sessions.get(sessionId)
}



export { createFakeCtx, makeSession }
