import { Plugin } from "@opencode/plugin/tui"
import type { AgentInfo, ModelInfo, SessionInfo } from "@opencode/client"
import { batch, createEffect, createMemo, createSignal } from "solid-js"
import { isReviewer } from "./src/shared/agents"
import { isSidebarStatusEvent, shouldRefreshSidebar } from "./src/shared/events"
import { defaultSettings, normalizeSnapshot } from "./src/shared/settings"
import type { ChoreographerSettings, Ui } from "./src/shared/settings"
import { ChoreographerRpc } from "./src/shared/rpc"
import { modelName, normalizeTodoStatus, sanitize } from "./src/tui/format"
import type { Section, TodoItem } from "./src/tui/format"
import { SettingsPanel } from "./src/tui/settings-panel"
import { Sidebar } from "./src/tui/sidebar"

export default Plugin.define({
  id: "openchoreographer.tui",
  async setup(context) {
    const location = context.location ?? context.data.location.default()

    const [dataVersion, setDataVersion] = createSignal(0)
    const bump = () => setDataVersion((n) => n + 1)
    const [metadataVersion, setMetadataVersion] = createSignal(0)
    const [currentSession, setCurrentSession] = createSignal<string | undefined>(undefined)

    const sync = async (notify: boolean) => {
      const results = await Promise.allSettled([
        context.data.location.agent.sync(location),
        context.data.location.model.sync(location),
      ])
      if (notify && results.some((result) => result.status === "rejected")) {
        context.ui.toast.show({ message: "Agent roster unavailable", variant: "warning" })
      }
      bump()
    }
    void sync(true)

    const [settings, setSettings] = context.storage.store<ChoreographerSettings>("openchoreographer.settings", { initial: defaultSettings() })
    const loadedUi = (settings as { ui?: Partial<Ui> }).ui
    if (loadedUi === undefined || typeof loadedUi.todos !== "boolean" || typeof loadedUi.roster !== "boolean") {
      void setSettings((draft) => {
        const existing = (draft as { ui?: Partial<Ui> }).ui
        draft.ui = {
          todos: typeof existing?.todos === "boolean" ? existing.todos : true,
          roster: typeof existing?.roster === "boolean" ? existing.roster : true,
        }
      })
    }
    const [managed, setManaged] = createSignal<string[]>([])
    const [defaults, setDefaults] = createSignal<Record<string, number | null>>({})
    const [online, setOnline] = createSignal(true)
    let inflight = 0
    let mutation = 0
    let disposed = false

    const rpc = context.client.rpc(ChoreographerRpc)
    const callOptions = { location: { directory: location.directory } }

    const applySnapshot = (value: unknown) => {
      const snap = normalizeSnapshot(value)
      if (snap === undefined) return
      const currentSteps = settings.steps
      const snapSteps = snap.steps
      const currentKeys = Object.keys(currentSteps)
      const snapKeys = Object.keys(snapSteps)
      const stepsSame =
        currentKeys.length === snapKeys.length &&
        snapKeys.every((key) => currentSteps[key] === snapSteps[key])
      const currentManaged = managed()
      const managedSame =
        currentManaged.length === snap.managed.length &&
        snap.managed.every((id, index) => currentManaged[index] === id)
      const currentDefaults = defaults()
      const defaultKeys = Object.keys(currentDefaults)
      const snapDefaultKeys = Object.keys(snap.defaults)
      const defaultsSame =
        defaultKeys.length === snapDefaultKeys.length &&
        snapDefaultKeys.every((key) => currentDefaults[key] === snap.defaults[key])
      const animationsSame =
        settings.animations.todo === snap.animations.todo &&
        settings.animations.running === snap.animations.running
      const uiSame =
        (settings.ui?.todos ?? true) === snap.ui.todos &&
        (settings.ui?.roster ?? true) === snap.ui.roster
      if (animationsSame && uiSame && stepsSame && managedSame && defaultsSame) return
      batch(() => {
        void setSettings((draft) => {
          draft.animations = { todo: snap.animations.todo, running: snap.animations.running }
          draft.ui = { todos: snap.ui.todos, roster: snap.ui.roster }
          draft.steps = { ...snap.steps }
        })
        setManaged([...snap.managed])
        setDefaults({ ...snap.defaults })
        bump()
      })
    }

    const syncSettings = async (notify: boolean): Promise<boolean> => {
      const at = mutation
      try {
        const snap = await rpc.getSettings({}, callOptions)
        if (at !== mutation) return true
        applySnapshot(snap)
        setOnline(true)
        return true
      } catch {
        setOnline(false)
        if (notify) context.ui.toast.show({ message: "Choreographer settings unavailable", variant: "warning" })
        return false
      }
    }
    const settle = () => {
      inflight -= 1
    }
    void syncSettings(false).then((ok) => {
      if (ok || disposed) return
      setTimeout(() => { if (!disposed) void syncSettings(true) }, 1000)
    })
    let offSettings: (() => void) | undefined
    try {
      offSettings = rpc.events.on("updated", (event) => {
        if (inflight !== 0) return
        applySnapshot(event.data)
      })
    } catch {
      // The panel re-syncs on open, so a missed live subscription is recoverable.
    }

    const toggleAnimation = (key: "todo" | "running") => {
      const value = !settings.animations[key]
      mutation += 1
      void setSettings((draft) => {
        draft.animations[key] = value
      })
      bump()
      inflight += 1
      void rpc.setSettings({ animations: key === "todo" ? { todo: value } : { running: value } }, callOptions).catch(() => {
        setOnline(false)
        context.ui.toast.show({ message: "Choreographer settings unavailable", variant: "warning" })
      }).finally(settle)
    }

    const toggleUi = (key: "todos" | "roster") => {
      const value = !(settings.ui?.[key] ?? true)
      mutation += 1
      void setSettings((draft) => {
        draft.ui = { ...(draft.ui ?? { todos: true, roster: true }), [key]: value }
      })
      bump()
      inflight += 1
      void rpc.setSettings({ ui: key === "todos" ? { todos: value } : { roster: value } }, callOptions).catch(() => {
        setOnline(false)
        context.ui.toast.show({ message: "Choreographer settings unavailable", variant: "warning" })
      }).finally(settle)
    }

    let stepsTimer: ReturnType<typeof setTimeout> | undefined
    const pendingSteps = new Map<string, number | null>()
    const flushSteps = () => {
      if (pendingSteps.size === 0) return
      const payload: Record<string, number | null> = {}
      for (const [id, value] of pendingSteps) payload[id] = value
      const before = { ...settings.steps }
      pendingSteps.clear()
      if (stepsTimer !== undefined) {
        clearTimeout(stepsTimer)
        stepsTimer = undefined
      }
      const at = mutation
      inflight += 1
      void rpc.setSettings({ steps: payload }, callOptions).then((snap) => {
        if (at !== mutation) return
        applySnapshot(snap)
      }).catch(() => {
        setOnline(false)
        context.ui.toast.show({ message: "Could not save steps: server plugin unreachable", variant: "warning" })
        void setSettings((draft) => {
          draft.steps = before
        })
        void syncSettings(false)
      }).finally(settle)
    }
    const queueSteps = (id: string, value: number | null) => {
      mutation += 1
      void setSettings((draft) => {
        if (value === null) delete draft.steps[id]
        else draft.steps[id] = value
      })
      pendingSteps.set(id, value)
      if (stepsTimer !== undefined) clearTimeout(stepsTimer)
      stepsTimer = setTimeout(flushSteps, 200)
    }

    const saveSteps = (id: string, value: number) => {
      queueSteps(id, value)
    }

    const resetSteps = (id: string) => {
      queueSteps(id, null)
    }

    const agentById = (id: string): AgentInfo | undefined => (agentList() ?? []).find((agent) => agent.id === id)

    const openSettings = () => {
      if (inflight === 0) void syncSettings(false)
      context.ui.dialog.set({ size: "large", centered: true })
      context.ui.dialog.show(() => (
        <SettingsPanel
          context={context}
          settings={settings}
          managed={managed}
          defaults={defaults}
          online={online}
          agentById={agentById}
          saveSteps={saveSteps}
          resetSteps={resetSteps}
          toggleAnimation={toggleAnimation}
          toggleUi={toggleUi}
          flushSteps={flushSteps}
        />
      ))
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "openchoreographer.settings",
        title: "Choreographer settings",
        description: "Animations and agent step budgets",
        group: "openchoreographer",
        palette: true,
        slash: { name: "choreographer" },
        run: () => openSettings(),
      }],
    }))

    const agentList = createMemo((): AgentInfo[] | undefined => {
      dataVersion()
      return context.data.location.agent.list(location)
    })
    const models = createMemo((): ModelInfo[] => {
      dataVersion()
      return context.data.location.model.list(location) ?? []
    })
    const modelIndex = createMemo((): Map<string, string> => {
      const index = new Map<string, string>()
      for (const model of models()) {
        const label = model?.name?.trim() || `${model.providerID}/${model.id}`
        index.set(`${model.providerID}/${model.id}`, label)
        if (model.modelID && model.modelID !== model.id) index.set(`${model.providerID}/${model.modelID}`, label)
      }
      return index
    })
    const subagentList = createMemo((): AgentInfo[] => {
      return (agentList() ?? []).filter((agent) => !agent.hidden && agent.mode === "subagent").sort((a, b) => a.name.localeCompare(b.name))
    })
    const primary = createMemo((): AgentInfo[] => {
      return (agentList() ?? []).filter((agent) => !agent.hidden && agent.mode !== "subagent").sort((a, b) => a.name.localeCompare(b.name))
    })
    const reviewers = createMemo((): AgentInfo[] => {
      return subagentList().filter((agent) => isReviewer(agent.id))
    })
    const workers = createMemo((): AgentInfo[] => {
      return subagentList().filter((agent) => !isReviewer(agent.id))
    })
    const visibleAgentCount = createMemo((): number => {
      return (agentList() ?? []).filter((agent) => !agent.hidden).length
    })

    const [open, setOpen] = createSignal<Record<string, Record<Section, boolean>>>({})
    const DEFAULT_OPEN: Record<Section, boolean> = { agents: true, primary: false, workers: false, reviewers: false, todos: true }
    const isOpen = (sessionID: string, section: Section): boolean => open()[sessionID]?.[section] ?? DEFAULT_OPEN[section]
    const toggle = (sessionID: string, section: Section) => {
      const next = !isOpen(sessionID, section)
      setOpen((state) => ({ ...state, [sessionID]: { ...(state[sessionID] ?? DEFAULT_OPEN), [section]: next } }))
    }

    const activeModel = (agent: AgentInfo, sessionID: string): string => {
      dataVersion()
      const session = context.data.session.get(sessionID)
      if (session?.agent === agent.id && session.model) return modelName(session.model, modelIndex())
      return agent.model ? modelName(agent.model, modelIndex()) : "inherit"
    }

    const running = (): SessionInfo[] => {
      dataVersion()
      const sessionID = currentSession()
      if (sessionID === undefined) return []
      const result: SessionInfo[] = []
      for (const id of context.data.session.family(sessionID)) {
        if (id === sessionID) continue
        const session = context.data.session.get(id)
        if (session?.parentID && context.data.session.status(id) === "running") result.push(session)
      }
      return result
    }

    const todoCache = new WeakMap<object, { raw: object; version: number; items: TodoItem[] }>()
    const todoItems = (sessionID: string): TodoItem[] => {
      dataVersion()
      const version = metadataVersion()
      const raw = context.data.session.get(sessionID)?.metadata?.["openchoreographer.todos"]
      if (!Array.isArray(raw)) return []
      const cached = todoCache.get(raw)
      if (cached !== undefined && cached.raw === raw && cached.version === version) return cached.items
      const items: TodoItem[] = []
      for (const entry of raw) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
        const record = entry as Record<string, unknown>
        const content = record.content
        if (typeof content !== "string") continue
        items.push({
          id: typeof record.id === "string" ? record.id : undefined,
          content: sanitize(content),
          status: normalizeTodoStatus(record.status),
        })
      }
      todoCache.set(raw, { raw, version, items })
      return items
    }

    const todoDone = (sessionID: string) =>
      todoItems(sessionID).filter((item) => item.status === "completed" || item.status === "cancelled").length

    const [todoPhase, setTodoPhase] = createSignal(0)
    const [todoAnimFor, setTodoAnimFor] = createSignal<string | undefined>(undefined)
    let todoTimer: ReturnType<typeof setInterval> | undefined
    createEffect(() => {
      const sessionID = todoAnimFor()
      const active =
        sessionID !== undefined && (settings.ui?.todos ?? true) && settings.animations.todo && isOpen(sessionID, "todos") && todoItems(sessionID).some((item) => item.status === "in_progress")
      if (active && todoTimer === undefined) {
        todoTimer = setInterval(() => {
          setTodoPhase((value) => value + 3)
        }, 120)
      } else if (!active && todoTimer !== undefined) {
        clearInterval(todoTimer)
        todoTimer = undefined
      }
    })

    let refreshToasted = false
    let pendingRoster = false

    const refresh = async (syncRoster: boolean) => {
      if (syncRoster) {
        context.data.location.agent.invalidate(location)
        context.data.location.model.invalidate(location)
      }
      const current = currentSession()
      const ids = current !== undefined ? [...context.data.session.family(current)] : []
      for (const id of ids) {
        try {
          context.data.session.invalidate(id)
        } catch { /* per-session failures retry on the next event */ }
      }
      await Promise.allSettled(ids.map((id) => context.data.session.sync(id)))
      if (syncRoster) {
        const results = await Promise.allSettled([context.data.location.agent.sync(location), context.data.location.model.sync(location)])
        if (results.some((result) => result.status === "rejected") && !refreshToasted) {
          refreshToasted = true
          context.ui.toast.show({ message: "Agent roster unavailable", variant: "warning" })
        }
      }
      bump()
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let refreshing = false
    let pending = false
    const runRefresh = () => {
      timer = undefined
      refreshing = true
      const syncRoster = pendingRoster
      pendingRoster = false
      pending = false
      void refresh(syncRoster).finally(() => {
        refreshing = false
        if (pending) {
          pending = false
          timer = setTimeout(runRefresh, 250)
        }
      })
    }
    const scheduleStructural = (type: string) => {
      if (type === "agent.updated" || type === "model.updated") pendingRoster = true
      if (refreshing) {
        pending = true
        return
      }
      if (timer === undefined) timer = setTimeout(runRefresh, 250)
    }

    const run = createMemo(() => running())

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        if (currentSession() !== sessionID) setCurrentSession(sessionID)
        if (todoAnimFor() !== sessionID) setTodoAnimFor(sessionID)
        return (
          <Sidebar
            context={context}
            sessionID={sessionID}
            settings={settings}
            isOpen={(section) => isOpen(sessionID, section)}
            toggle={(section) => toggle(sessionID, section)}
            agentList={agentList}
            primary={primary}
            workers={workers}
            reviewers={reviewers}
            visibleAgentCount={visibleAgentCount}
            run={run}
            modelIndex={modelIndex}
            activeModel={(agent) => activeModel(agent, sessionID)}
            todoItems={() => todoItems(sessionID)}
            todoDone={() => todoDone(sessionID)}
            todoPhase={todoPhase}
            dataVersion={dataVersion}
          />
        )
      },
    })

    const offListen = context.data.listen((event) => {
      const type = event.details.type
      if (type === "session.metadata.updated" || type === "session.deleted") setMetadataVersion((n) => n + 1)
      if (shouldRefreshSidebar(type)) scheduleStructural(type)
      else if (isSidebarStatusEvent(type)) bump()
    })

    return () => {
      if (pendingSteps.size > 0) flushSteps()
      unregister()
      offListen()
      disposed = true
      offSettings?.()
      if (timer !== undefined) clearTimeout(timer)
      if (stepsTimer !== undefined) clearTimeout(stepsTimer)
      if (todoTimer !== undefined) clearInterval(todoTimer)
    }
  },
})
