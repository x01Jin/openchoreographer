import { Plugin } from "@opencode/plugin/tui"
import type { AgentInfo, ModelInfo, SessionInfo } from "@opencode/client"
import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { ScrollBoxRenderable } from "@opentui/core"
import { displayWidth, isReviewer, isSidebarStatusEvent, shouldRefreshSidebar } from "./shared"
import { STEPS_STEP, clampSteps, defaultSettings, normalizeSnapshot } from "./settings"
import type { ChoreographerSettings, Ui } from "./settings"
import { ChoreographerRpc } from "./rpc"

type ModelRefLike = { id: string; providerID: string; variant?: string }

type Section = "agents" | "primary" | "workers" | "reviewers" | "todos"

type TodoItem = {
  id?: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
}

const NAME_WIDTH = 15
const MODEL_WIDTH = 15
const TODO_LIMIT = 12

const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"]

function normalizeTodoStatus(value: unknown): TodoItem["status"] {
  return typeof value === "string" && TODO_STATUSES.includes(value)
    ? (value as TodoItem["status"])
    : "pending"
}

type GraphemeSegmenter = { segment(value: string): Iterable<{ segment: string }> }

function createSegmenter(): GraphemeSegmenter | undefined {
  try {
    const Ctor = (Intl as unknown as { Segmenter?: new (locales?: string, options?: { granularity: string }) => GraphemeSegmenter }).Segmenter
    return Ctor ? new Ctor(undefined, { granularity: "grapheme" }) : undefined
  } catch {
    return undefined
  }
}

const segmenter = createSegmenter()

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
}

const truncateCache = new Map<string, string>()

function truncate(value: string, width: number): string {
  const key = `${width}:${value}`
  const hit = truncateCache.get(key)
  if (hit !== undefined) return hit
  const clean = sanitize(value)
  let result: string
  if (/^[\x00-\x7F]*$/.test(clean) && clean.length <= width) {
    result = clean
  } else {
    const cells = segmenter ? Array.from(segmenter.segment(clean), (part) => part.segment) : Array.from(clean)
    let total = 0
    for (const cell of cells) total += displayWidth(cell)
    if (total <= width) result = clean
    else {
      let used = 0
      let end = 0
      for (; end < cells.length; end += 1) {
        const cellWidth = displayWidth(cells[end])
        if (used + cellWidth > width - 1) break
        used += cellWidth
      }
      result = cells.slice(0, end).join("") + "…"
    }
  }
  if (truncateCache.size > 512) truncateCache.clear()
  truncateCache.set(key, result)
  return result
}

function modelName(ref: ModelRefLike, index: Map<string, string>): string {
  const name = index.get(`${ref.providerID}/${ref.id}`) ?? `${ref.providerID}/${ref.id}`
  return ref.variant ? `${name}#${ref.variant}` : name
}

const PALETTE = ["#8aadf4", "#a6da95", "#eed49f", "#f5a97f", "#c6a0f6", "#8bd5ca", "#ed8796", "#ee99a0"]

function hashColor(id: string): string {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

function agentColor(agent: AgentInfo | undefined, id: string | undefined): string {
  return agent?.color ?? hashColor(id ?? "unknown")
}

function hueHex(index: number, phase: number): string {
  const hue = (((index * 47 + phase) % 360) + 360) % 360
  const chroma = (1 - Math.abs(2 * 0.65 - 1)) * 0.7
  const segment = hue / 60
  const second = chroma * (1 - Math.abs((segment % 2) - 1))
  const match = 0.65 - chroma / 2
  const [r, g, b] =
    segment < 1 ? [chroma, second, 0] :
    segment < 2 ? [second, chroma, 0] :
    segment < 3 ? [0, chroma, second] :
    segment < 4 ? [0, second, chroma] :
    segment < 5 ? [second, 0, chroma] :
    [chroma, 0, second]
  const channel = (value: number) => Math.round((value + match) * 255).toString(16).padStart(2, "0")
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

const FLOW = ["#8aadf4", "#b4befe", "#c6a0f6", "#f5c2e7", "#f38ba8", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89dceb"]

function FlowingLabel(props: { text: string; animate: boolean }) {
  const [phase, setPhase] = createSignal(0)
  createEffect(() => {
    if (!props.animate) return
    const timer = setInterval(() => setPhase((value) => value + 1), 140)
    onCleanup(() => clearInterval(timer))
  })
  const slices = createMemo(() => {
    const all = Array.from(props.text)
    if (all.length < 3) return [all.join("")]
    const cut1 = Math.ceil(all.length / 3)
    const cut2 = Math.ceil((all.length * 2) / 3)
    return [all.slice(0, cut1).join(""), all.slice(cut1, cut2).join(""), all.slice(cut2).join("")]
  })
  return (
    <Show
      when={props.animate}
      fallback={
        <text fg={FLOW[0]} selectable={false} attributes={TextAttributes.BOLD}>{props.text}</text>
      }
    >
      <Show
        when={slices().length === 3}
        fallback={
          <text fg={FLOW[(phase() + 0) % FLOW.length]} selectable={false} attributes={TextAttributes.BOLD}>{slices()[0]}</text>
        }
      >
        <box flexDirection="row">
          <text fg={FLOW[(phase() + 0) % FLOW.length]} selectable={false} attributes={TextAttributes.BOLD}>{slices()[0]}</text>
          <text fg={FLOW[(phase() + 3) % FLOW.length]} selectable={false} attributes={TextAttributes.BOLD}>{slices()[1]}</text>
          <text fg={FLOW[(phase() + 6) % FLOW.length]} selectable={false} attributes={TextAttributes.BOLD}>{slices()[2]}</text>
        </box>
      </Show>
    </Show>
  )
}

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

    type SettingsRow =
      | { kind: "animation"; key: "todo" | "running"; label: string }
      | { kind: "ui"; key: "todos" | "roster"; label: string }
      | { kind: "agent"; id: string; label: string }

    const agentById = (id: string): AgentInfo | undefined => (agentList() ?? []).find((agent) => agent.id === id)

    const openSettings = () => {
      if (inflight === 0) void syncSettings(false)
      context.ui.dialog.set({ size: "large", centered: true })
      context.ui.dialog.show(() => <SettingsPanel />)
    }

    const SettingsPanel = () => {
      const [selected, setSelected] = createSignal(0)
      onCleanup(() => {
        if (pendingSteps.size > 0) flushSteps()
      })
      let scrollRef: ScrollBoxRenderable | undefined
      const rows = createMemo((): SettingsRow[] => {
        const list: SettingsRow[] = [
          { kind: "animation", key: "todo", label: "TODO animations" },
          { kind: "animation", key: "running", label: "RUNNING animations" },
          { kind: "ui", key: "todos", label: "TODO panel" },
          { kind: "ui", key: "roster", label: "Agent roster" },
        ]
        for (const id of managed()) list.push({ kind: "agent", id, label: truncate(id, 18) })
        return list
      })
      const viewportHeight = () => Math.max(4, Math.floor((context.renderer.height || 32) * 0.5) - 4)
      const current = () => Math.min(selected(), Math.max(0, rows().length - 1))
      const reveal = (index: number) => {
        const id = `choreographer-row-${index}`
        queueMicrotask(() => scrollRef?.scrollChildIntoView(id))
      }
      const move = (delta: number) => {
        const count = rows().length
        if (count === 0) return
        const next = Math.min(count - 1, Math.max(0, current() + delta))
        setSelected(next)
        reveal(next)
      }
      const adjustRow = (id: string, delta: number) => {
        const effective = settings.steps[id] ?? defaults()[id] ?? agentById(id)?.steps ?? null
        saveSteps(id, clampSteps((effective ?? 0) + delta))
      }
      const adjust = (delta: number) => {
        const row = rows()[current()]
        if (row?.kind === "agent") adjustRow(row.id, delta)
      }
      const act = () => {
        const row = rows()[current()]
        if (row?.kind === "animation") toggleAnimation(row.key)
        else if (row?.kind === "ui") toggleUi(row.key)
      }
      const reset = () => {
        const row = rows()[current()]
        if (row?.kind === "agent") resetSteps(row.id)
      }
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          { bind: "up", run: () => move(-1) },
          { bind: "down", run: () => move(1) },
          { bind: "left", run: () => adjust(-STEPS_STEP) },
          { bind: "right", run: () => adjust(STEPS_STEP) },
          { bind: "return", run: () => act() },
          { bind: "space", run: () => act() },
          { bind: "r", run: () => reset() },
          { bind: "escape", run: () => context.ui.dialog.clear() },
        ],
      }))
      const rowLine = (row: SettingsRow, index: number) => {
        const active = () => index === current()
        const marker = () => (active() ? "▸ " : "  ")
        const select = () => setSelected(index)
        const accent = row.kind === "animation" ? FLOW[0] : row.kind === "ui" ? FLOW[1] : agentColor(agentById(row.id), row.id)
        const label = (
          <box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
            <text wrapMode="none" fg={accent} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
              {`${marker()}${row.label}`}
            </text>
          </box>
        )
        if (row.kind === "animation" || row.kind === "ui") {
          const on = () => row.kind === "animation" ? settings.animations[row.key] : (settings.ui?.[row.key] ?? true)
          const toggleRow = () => {
            if (row.kind === "animation") toggleAnimation(row.key)
            else toggleUi(row.key)
          }
          return (
            <box
              flexDirection="row"
              width="100%"
              justifyContent="space-between"
              columnGap={2}
              onMouseDown={(event) => {
                if (event.button !== 0 || event.isDragging) return
                select()
                toggleRow()
              }}
            >
              {label}
              <text fg={on() ? "#a6e3a1" : "#f5a97f"} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
                {on() ? "on" : "off"}
              </text>
            </box>
          )
        }
        const override = () => settings.steps[row.id]
        const file = () => defaults()[row.id]
        const effective = () => settings.steps[row.id] ?? defaults()[row.id] ?? agentById(row.id)?.steps ?? null
        const changed = () => override() !== undefined && typeof file() === "number" && file() !== override()
        const nudge = (delta: number) => (event: { button: number; isDragging?: boolean; stopPropagation: () => void }) => {
          if (event.button !== 0 || event.isDragging) return
          event.stopPropagation()
          select()
          adjustRow(row.id, delta)
        }
        return (
          <box
            flexDirection="row"
            width="100%"
            justifyContent="space-between"
            columnGap={2}
            onMouseDown={(event) => {
              if (event.button !== 0 || event.isDragging) return
              select()
            }}
          >
            {label}
            <box flexDirection="row" columnGap={1} flexShrink={0}>
              <box onMouseDown={nudge(-STEPS_STEP)}>
                <text fg={accent} selectable={false}>−</text>
              </box>
              <text
                fg={accent}
                attributes={active() ? TextAttributes.BOLD : undefined}
                selectable={false}
              >
                {effective() === null ? "—" : `${effective()}`}
              </text>
              <box onMouseDown={nudge(STEPS_STEP)}>
                <text fg={accent} selectable={false}>+</text>
              </box>
              <Show when={changed()}>
                <text fg={context.theme.text.faint} selectable={false}>{`default ${file()}`}</text>
              </Show>
            </box>
          </box>
        )
      }
      const section = (title: string, colour: string) => (
        <box marginTop={1}>
          <text fg={colour} attributes={TextAttributes.BOLD} selectable={false}>{title}</text>
        </box>
      )
      return (
        <box
          flexDirection="column"
          width="100%"
          paddingX={2}
          paddingY={1}
        >
          <box flexDirection="row" width="100%" justifyContent="space-between" alignItems="center">
            <text fg={context.theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>Choreographer settings</text>
            <box height={1} onMouseDown={(event) => { if (event.button === 0) context.ui.dialog.clear() }}>
              <text fg={context.theme.text.muted} attributes={TextAttributes.BOLD} selectable={false}>[esc]</text>
            </box>
          </box>
          <box width="100%" overflow="hidden">
            <text fg={context.theme.text.faint} wrapMode="none" selectable={false}>{"─".repeat(200)}</text>
          </box>
          <scrollbox
            ref={(node) => (scrollRef = node ?? undefined)}
            width="100%"
            height={Math.min(rows().length + 4, viewportHeight())}
            scrollY={true}
            scrollX={false}
            stickyScroll={false}
            paddingRight={1}
          >
            <For each={rows()}>
              {(row, index) => (
                <box id={`choreographer-row-${index()}`} flexDirection="column" width="100%">
                  <Show when={index() === 0}>{section("ANIMATIONS", FLOW[0])}</Show>
                  <Show when={index() === 2}>{section("INTERFACE", FLOW[1])}</Show>
                  <Show when={index() === 4}>{section("AGENT STEPS", "#c6a0f6")}</Show>
                  {rowLine(row, index())}
                </box>
              )}
            </For>
          </scrollbox>
          <box marginTop={1} width="100%" overflow="hidden">
            <text fg={context.theme.text.faint} wrapMode="none" selectable={false}>{"─".repeat(200)}</text>
          </box>
          <text fg={context.theme.text.faint} wrapMode="none" selectable={false}>↑↓ move · ←→ ±5 · enter toggle · r reset</text>
          <text fg={context.theme.text.faint} wrapMode="none" selectable={false}>click to select · wheel to scroll · − / + adjusts</text>
          <text fg={online() ? "#a6e3a1" : "#f5a97f"} selectable={false}>
            {online() ? "plugin connected" : "plugin unreachable: local only"}
          </text>
        </box>
      )
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

    const header = (sessionID: string, section: Section, title: string, count: () => string | number, small = false) => (
      <box
        width="100%"
        focusable
        onMouseDown={(event) => {
          if (event.button !== 0 || event.isDragging) return
          toggle(sessionID, section)
        }}
        onKeyDown={(event) => {
          if (event.name === "return" || event.name === "space") toggle(sessionID, section)
        }}
      >
        <text fg={context.theme.text.base} selectable={false} attributes={TextAttributes.BOLD}>{`${isOpen(sessionID, section) ? (small ? "▾" : "▼") : (small ? "▸" : "▶")} ${title}${isOpen(sessionID, section) ? "" : ` (${count()})`}`}</text>
      </box>
    )

    const row = (agent: AgentInfo, sessionID: string) => {
      const active = () => {
        dataVersion()
        return context.data.session.get(sessionID)?.agent === agent.id
      }
      return (
        <box flexDirection="row" width="100%" justifyContent="space-between" columnGap={1}>
          <box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
            <text wrapMode="none" flexShrink={0} fg={active() ? context.theme.text.base : context.theme.text.faint} selectable={false}>
              {active() ? "● " : "  "}
            </text>
            <text wrapMode="none" fg={agentColor(agent, agent.id)} selectable={false}>
              {truncate(agent.name, NAME_WIDTH)}
            </text>
          </box>
          <box flexShrink={0}>
            <text wrapMode="none" fg={active() ? context.theme.text.muted : context.theme.text.faint} selectable={false}>
              {truncate(activeModel(agent, sessionID), MODEL_WIDTH)}
            </text>
          </box>
        </box>
      )
    }

    const runningRow = (session: SessionInfo) => {
      const agent = () => (agentList() ?? []).find((candidate) => candidate.id === session.agent)
      const model = () => { const found = agent(); return session.model ? modelName(session.model, modelIndex()) : found?.model ? modelName(found.model, modelIndex()) : "inherit" }
      return (
        <box flexDirection="row" width="100%" justifyContent="space-between" columnGap={1}>
          <box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
            <text wrapMode="none" flexShrink={0} fg={context.theme.text.faint} selectable={false}>{"  "}</text>
            <text wrapMode="none" fg={agentColor(agent(), session.agent)} selectable={false}>
              {truncate(agent()?.name ?? session.agent ?? "unknown", NAME_WIDTH)}
            </text>
          </box>
          <box flexShrink={0}>
            <text wrapMode="none" fg={context.theme.text.muted} selectable={false}>
              {truncate(model(), MODEL_WIDTH)}
            </text>
          </box>
        </box>
      )
    }

    const todoRow = (item: TodoItem, index: number) => {
      const marker =
        item.status === "completed"
          ? "✓ "
          : item.status === "cancelled"
            ? "✕ "
            : item.status === "in_progress"
              ? "● "
              : "○ "
      const colour = () =>
        item.status === "completed"
          ? "#50fa7b"
          : item.status === "cancelled"
            ? "#ff5555"
            : item.status === "in_progress"
              ? hueHex(index, todoPhase())
              : context.theme.text.muted
      const attributes =
        item.status === "in_progress" || item.status === "completed" ? TextAttributes.BOLD : undefined
      return (
        <box flexDirection="row" width="100%" columnGap={1}>
          <text wrapMode="none" flexShrink={0} fg={colour()} attributes={attributes} selectable={false}>
            {marker}
          </text>
          <text wrapMode="word" flexShrink={1} minWidth={0} fg={colour()} attributes={attributes} selectable={false}>
            {item.content}
          </text>
        </box>
      )
    }

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
          <box flexDirection="column" gap={0} width="100%">
            <Show when={settings.ui?.roster ?? true}>
              {header(sessionID, "agents", "AGENTS & MODELS", () => visibleAgentCount())}
              <Show when={isOpen(sessionID, "agents")}>
                <Show when={agentList() !== undefined} fallback={<text fg={context.theme.text.faint} selectable={false}>roster unavailable</text>}>
                  <box flexDirection="column" width="100%" gap={0}>
                    <box flexDirection="column" width="100%">
                      {header(sessionID, "primary", "PRIMARY", () => primary().length, true)}
                      <Show when={isOpen(sessionID, "primary")}><For each={primary()}>{(agent) => row(agent, sessionID)}</For></Show>
                    </box>
                    <box flexDirection="column" width="100%">
                      {header(sessionID, "workers", "WORKERS", () => workers().length, true)}
                      <Show when={isOpen(sessionID, "workers")}><For each={workers()}>{(agent) => row(agent, sessionID)}</For></Show>
                    </box>
                    <box flexDirection="column" width="100%">
                      {header(sessionID, "reviewers", "REVIEWERS", () => reviewers().length, true)}
                      <Show when={isOpen(sessionID, "reviewers")}><For each={reviewers()}>{(agent) => row(agent, sessionID)}</For></Show>
                    </box>
                  </box>
                </Show>
              </Show>
            </Show>
            <Show when={run().length > 0 && (!(settings.ui?.roster ?? true) || isOpen(sessionID, "agents"))}>
              <box flexDirection="column" width="100%" marginTop={1}>
                <FlowingLabel text={`RUNNING (${run().length})`} animate={settings.animations.running} />
                <For each={run()}>{(session) => runningRow(session)}</For>
              </box>
            </Show>
            <Show when={(settings.ui?.todos ?? true) && todoItems(sessionID).length > 0}>
              <box flexDirection="column" width="100%" marginTop={1}>
                {header(sessionID, "todos", "TODOS", () => `${todoDone(sessionID)}/${todoItems(sessionID).length}`)}
                <Show when={isOpen(sessionID, "todos")}><For each={todoItems(sessionID).slice(0, TODO_LIMIT)}>{(item, index) => todoRow(item, index())}</For></Show>
              </box>
            </Show>
          </box>
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
