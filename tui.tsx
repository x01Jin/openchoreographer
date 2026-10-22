import { Plugin } from "@opencode/plugin/tui"
import type { AgentInfo, ModelInfo, SessionInfo } from "@opencode/client"
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { isReviewer } from "./shared"

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

function truncate(value: string, width: number): string {
  const clean = sanitize(value)
  const cells = segmenter ? Array.from(segmenter.segment(clean), (part) => part.segment) : Array.from(clean)
  if (cells.length <= width) return clean
  return cells.slice(0, Math.max(1, width - 1)).join("") + "…"
}

function modelName(ref: ModelRefLike, models: ModelInfo[]): string {
  const model = models.find((candidate) => candidate.providerID === ref.providerID && (candidate.id === ref.id || candidate.modelID === ref.id))
  const name = model?.name?.trim() || `${ref.providerID}/${ref.id}`
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

const FLOW = ["#8aadf4", "#b4befe", "#c6a0f6", "#f5c2e7", "#f38ba8", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89dceb"]

function FlowingLabel(props: { text: string }) {
  const [phase, setPhase] = createSignal(0)
  const timer = setInterval(() => setPhase((value) => value + 1), 140)
  onCleanup(() => clearInterval(timer))
  const chars = createMemo(() => Array.from(props.text))
  return (
    <box flexDirection="row">
      <For each={chars()}>
        {(char, index) => (
          <text fg={FLOW[((phase() - index()) % FLOW.length + FLOW.length) % FLOW.length]} selectable={false} attributes={TextAttributes.BOLD}>{char}</text>
        )}
      </For>
    </box>
  )
}

export default Plugin.define({
  id: "openchoreographer.tui",
  async setup(context) {
    const location = context.location ?? context.data.location.default()

    const [tick, setTick] = createSignal(0)
    const bump = () => setTick((n) => n + 1)

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
    await sync(true)

    const agents = (): AgentInfo[] | undefined => {
      tick()
      return context.data.location.agent.list(location)
    }
    const models = (): ModelInfo[] => {
      tick()
      return context.data.location.model.list(location) ?? []
    }
    const primary = (): AgentInfo[] => {
      tick()
      return (agents() ?? []).filter((agent) => !agent.hidden && agent.mode !== "subagent").sort((a, b) => a.name.localeCompare(b.name))
    }
    const subagents = (): AgentInfo[] => {
      tick()
      return (agents() ?? []).filter((agent) => !agent.hidden && agent.mode === "subagent").sort((a, b) => a.name.localeCompare(b.name))
    }
    const reviewers = (): AgentInfo[] => {
      tick()
      return subagents().filter((agent) => isReviewer(agent.id))
    }
    const workers = (): AgentInfo[] => {
      tick()
      return subagents().filter((agent) => !isReviewer(agent.id))
    }

    const [open, setOpen] = createSignal<Record<string, Record<Section, boolean>>>({})
    const DEFAULT_OPEN: Record<Section, boolean> = { agents: true, primary: false, workers: false, reviewers: false, todos: true }
    const isOpen = (sessionID: string, section: Section): boolean => open()[sessionID]?.[section] ?? DEFAULT_OPEN[section]
    const toggle = (sessionID: string, section: Section) => {
      const next = !isOpen(sessionID, section)
      setOpen((state) => ({ ...state, [sessionID]: { ...(state[sessionID] ?? DEFAULT_OPEN), [section]: next } }))
    }

    const activeModel = (agent: AgentInfo, sessionID: string): string => {
      tick()
      const session = context.data.session.get(sessionID)
      if (session?.agent === agent.id && session.model) return modelName(session.model, models())
      return agent.model ? modelName(agent.model, models()) : "inherit"
    }

    const running = (sessionID: string): SessionInfo[] => {
      tick()
      const result: SessionInfo[] = []
      for (const id of context.data.session.family(sessionID)) {
        if (id === sessionID) continue
        const session = context.data.session.get(id)
        if (session?.parentID && context.data.session.status(id) === "running") result.push(session)
      }
      return result
    }

    const todoItems = (sessionID: string): TodoItem[] => {
      tick()
      const raw = context.data.session.get(sessionID)?.metadata?.["openchoreographer.todos"]
      if (!Array.isArray(raw)) return []
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
      return items
    }

    const todoDone = (sessionID: string) =>
      todoItems(sessionID).filter((item) => item.status === "completed" || item.status === "cancelled").length

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
      const active = () => { tick(); return context.data.session.get(sessionID)?.agent === agent.id }
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
      const agent = () => { tick(); return (agents() ?? []).find((candidate) => candidate.id === session.agent) }
      const model = () => { tick(); const found = agent(); return session.model ? modelName(session.model, models()) : found?.model ? modelName(found.model, models()) : "inherit" }
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

    const todoRow = (item: TodoItem) => {
      const done = item.status === "completed" || item.status === "cancelled"
      const marker =
        item.status === "completed"
          ? "✓ "
          : item.status === "cancelled"
            ? "✕ "
            : item.status === "in_progress"
              ? "● "
              : "○ "
      const color = done
        ? context.theme.text.faint
        : item.status === "in_progress"
          ? context.theme.text.base
          : context.theme.text.muted
      return (
        <box flexDirection="row" width="100%" columnGap={1}>
          <text wrapMode="none" flexShrink={0} fg={color} selectable={false}>
            {marker}
          </text>
          <text wrapMode="word" flexShrink={1} minWidth={0} fg={color} selectable={false}>
            {item.content}
          </text>
        </box>
      )
    }

    const seen = new Set<string>()
    let refreshToasted = false

    const refresh = async () => {
      context.data.location.agent.invalidate(location)
      context.data.location.model.invalidate(location)
      const ids = new Set<string>()
      for (const root of seen) for (const id of context.data.session.family(root)) ids.add(id)
      for (const id of ids) {
        try {
          context.data.session.invalidate(id)
          await context.data.session.sync(id)
        } catch { /* per-session failures retry on the next event */ }
      }
      const results = await Promise.allSettled([context.data.location.agent.sync(location), context.data.location.model.sync(location)])
      if (results.some((result) => result.status === "rejected") && !refreshToasted) {
        refreshToasted = true
        context.ui.toast.show({ message: "Agent roster unavailable", variant: "warning" })
      }
      bump()
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let refreshing = false
    const scheduleRefresh = () => {
      if (refreshing || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        refreshing = true
        void refresh().finally(() => { refreshing = false })
      }, 150)
    }

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        tick()
        seen.add(sessionID)
        const run = running(sessionID)
        return (
          <box flexDirection="column" gap={0} width="100%">
            {header(sessionID, "agents", "AGENTS & MODELS", () => (agents() ?? []).filter((agent) => !agent.hidden).length)}
            <Show when={isOpen(sessionID, "agents")}>
              <Show when={agents() !== undefined} fallback={<text fg={context.theme.text.faint} selectable={false}>roster unavailable</text>}>
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
              <Show when={run.length > 0}>
                <box flexDirection="column" width="100%" marginTop={1}>
                  <FlowingLabel text={`RUNNING (${run.length})`} />
                  <For each={run}>{(session) => runningRow(session)}</For>
                </box>
              </Show>
            </Show>
            <Show when={todoItems(sessionID).length > 0}>
              <box flexDirection="column" width="100%">
                {header(sessionID, "todos", "TODOS", () => `${todoDone(sessionID)}/${todoItems(sessionID).length}`)}
                <Show when={isOpen(sessionID, "todos")}><For each={todoItems(sessionID).slice(0, TODO_LIMIT)}>{(item) => todoRow(item)}</For></Show>
              </box>
            </Show>
          </box>
        )
      },
    })

    const offListen = context.data.listen((event) => {
      const type = event.details.type
      if (type.startsWith("session.") || type.startsWith("message.") || type === "agent.updated" || type === "model.updated") scheduleRefresh()
    })

    return () => {
      unregister()
      offListen()
      if (timer !== undefined) clearTimeout(timer)
    }
  },
})
