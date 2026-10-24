import type { AgentInfo, SessionInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createSignal } from "solid-js"
import type { Store } from "solid-js/store"
import { TextAttributes } from "@opentui/core"
import type { ChoreographerSettings } from "../shared/settings"
import { FLOW, MODEL_WIDTH, NAME_WIDTH, TODO_LIMIT, agentColor, hueHex, modelName, truncate } from "./format"
import type { Section, TodoItem } from "./format"
import { FlowingLabel } from "./flowing-label"

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

export type SidebarProps = {
  context: Context
  sessionID: string
  settings: Store<ChoreographerSettings>
  isOpen: (section: Section) => boolean
  toggle: (section: Section) => void
  agentList: () => AgentInfo[] | undefined
  primary: () => AgentInfo[]
  workers: () => AgentInfo[]
  reviewers: () => AgentInfo[]
  visibleAgentCount: () => number
  run: () => SessionInfo[]
  modelIndex: () => Map<string, string>
  activeModel: (agent: AgentInfo) => string
  todoItems: () => TodoItem[]
  todoDone: () => number
  todoPhase: () => number
  // Keeps row active-dot tracking identical: read in row's active(), as before.
  dataVersion: () => number
}

export function Sidebar(props: SidebarProps) {
  const sessionID = props.sessionID

  const header = (section: Section, title: string, count: () => string | number, small = false) => (
    <box
      width="100%"
      focusable
      onMouseDown={(event) => {
        if (event.button !== 0 || event.isDragging) return
        props.toggle(section)
      }}
      onKeyDown={(event) => {
        if (event.name === "return" || event.name === "space") props.toggle(section)
      }}
    >
      <text fg={props.context.theme.text.base} selectable={false} attributes={TextAttributes.BOLD}>{`${props.isOpen(section) ? (small ? "▾" : "▼") : (small ? "▸" : "▶")} ${title}${props.isOpen(section) ? "" : ` (${count()})`}`}</text>
    </box>
  )

  const row = (agent: AgentInfo) => {
    const active = () => {
      props.dataVersion()
      return props.context.data.session.get(sessionID)?.agent === agent.id
    }
    return (
      <box flexDirection="row" width="100%" justifyContent="space-between" columnGap={1}>
        <box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
          <text wrapMode="none" flexShrink={0} fg={active() ? props.context.theme.text.base : props.context.theme.text.faint} selectable={false}>
            {active() ? "● " : "  "}
          </text>
          <text wrapMode="none" fg={agentColor(agent, agent.id)} selectable={false}>
            {truncate(agent.name, NAME_WIDTH)}
          </text>
        </box>
        <box flexShrink={0}>
          <text wrapMode="none" fg={active() ? props.context.theme.text.muted : props.context.theme.text.faint} selectable={false}>
            {truncate(props.activeModel(agent), MODEL_WIDTH)}
          </text>
        </box>
      </box>
    )
  }

  const runningRow = (session: SessionInfo) => {
    const agent = () => (props.agentList() ?? []).find((candidate) => candidate.id === session.agent)
    const model = () => { const found = agent(); return session.model ? modelName(session.model, props.modelIndex()) : found?.model ? modelName(found.model, props.modelIndex()) : "inherit" }
    const [hovered, setHovered] = createSignal(false)
    return (
      <box
        flexDirection="row"
        width="100%"
        justifyContent="space-between"
        columnGap={1}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseDown={(event) => {
          if (event.button !== 0 || event.isDragging) return
          event.stopPropagation()
          props.context.ui.router.navigate({ type: "session", sessionID: session.id })
        }}
      >
        <box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
          <text wrapMode="none" flexShrink={0} fg={props.context.theme.text.faint} selectable={false}>{"  "}</text>
          <text wrapMode="none" fg={agentColor(agent(), session.agent)} attributes={hovered() ? TextAttributes.BOLD : undefined} selectable={false}>
            {truncate(agent()?.name ?? session.agent ?? "unknown", NAME_WIDTH)}
          </text>
          <text wrapMode="none" flexShrink={0} fg={hovered() ? props.context.theme.text.base : props.context.theme.text.faint} selectable={false}>{" ↗"}</text>
        </box>
        <box flexShrink={0}>
          <text wrapMode="none" fg={hovered() ? props.context.theme.text.base : props.context.theme.text.muted} selectable={false}>
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
            ? hueHex(index, props.todoPhase())
            : props.context.theme.text.muted
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

  return (
    <box flexDirection="column" gap={0} width="100%">
      <Show when={props.settings.ui?.roster ?? true}>
        {header("agents", "AGENTS & MODELS", () => props.visibleAgentCount())}
        <Show when={props.isOpen("agents")}>
          <Show when={props.agentList() !== undefined} fallback={<text fg={props.context.theme.text.faint} selectable={false}>roster unavailable</text>}>
            <box flexDirection="column" width="100%" gap={0}>
              <box flexDirection="column" width="100%">
                {header("primary", "PRIMARY", () => props.primary().length, true)}
                <Show when={props.isOpen("primary")}><For each={props.primary()}>{(agent) => row(agent)}</For></Show>
              </box>
              <box flexDirection="column" width="100%">
                {header("workers", "WORKERS", () => props.workers().length, true)}
                <Show when={props.isOpen("workers")}><For each={props.workers()}>{(agent) => row(agent)}</For></Show>
              </box>
              <box flexDirection="column" width="100%">
                {header("reviewers", "REVIEWERS", () => props.reviewers().length, true)}
                <Show when={props.isOpen("reviewers")}><For each={props.reviewers()}>{(agent) => row(agent)}</For></Show>
              </box>
            </box>
          </Show>
        </Show>
      </Show>
      <Show when={props.run().length > 0 && (!(props.settings.ui?.roster ?? true) || props.isOpen("agents"))}>
        <box flexDirection="column" width="100%" marginTop={1}>
          <FlowingLabel text={`RUNNING (${props.run().length})`} animate={props.settings.animations.running} />
          <For each={props.run()}>{(session) => runningRow(session)}</For>
        </box>
      </Show>
      <Show when={(props.settings.ui?.todos ?? true) && props.todoItems().length > 0}>
        <box flexDirection="column" width="100%" marginTop={1}>
          {header("todos", "TODOS", () => `${props.todoDone()}/${props.todoItems().length}`)}
          <Show when={props.isOpen("todos")}><For each={props.todoItems().slice(0, TODO_LIMIT)}>{(item, index) => todoRow(item, index())}</For></Show>
        </box>
      </Show>
    </box>
  )
}
