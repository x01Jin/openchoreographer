import { Plugin } from "@opencode/plugin/tui"
import type { AgentInfo, ModelInfo, SessionInfo } from "@opencode/client"
import { For, Show, createSignal } from "solid-js"

type ModelRefLike = { id: string; providerID: string; variant?: string }

type Section = "primary" | "workers" | "reviewers"

const NAME_WIDTH = 15
const MODEL_WIDTH = 15

function truncate(value: string, width: number): string {
  if (value.length <= width) return value
  return value.slice(0, Math.max(1, width - 1)) + "…"
}

function modelName(ref: ModelRefLike, models: ModelInfo[]): string {
  const model = models.find(
    (candidate) => candidate.providerID === ref.providerID && (candidate.id === ref.id || candidate.modelID === ref.id),
  )
  const name = model?.name?.trim() || `${ref.providerID}/${ref.id}`
  return ref.variant ? `${name}#${ref.variant}` : name
}

export default Plugin.define({
  id: "orchestrator.tui",
  async setup(context) {
    const location = context.location ?? context.data.location.default()

    const sync = async (notify: boolean) => {
      const results = await Promise.allSettled([
        context.data.location.agent.sync(location),
        context.data.location.model.sync(location),
      ])
      if (notify && results.some((result) => result.status === "rejected")) {
        context.ui.toast.show({ message: "Agent roster unavailable", variant: "warning" })
      }
    }
    await sync(true)

    const agents = () => context.data.location.agent.list(location) ?? []
    const models = () => context.data.location.model.list(location) ?? []
    const primary = () =>
      agents()
        .filter((agent) => !agent.hidden && agent.mode !== "subagent")
        .sort((a, b) => a.name.localeCompare(b.name))
    const subagents = () =>
      agents()
        .filter((agent) => !agent.hidden && agent.mode === "subagent")
        .sort((a, b) => a.name.localeCompare(b.name))
    const reviewers = () => subagents().filter((agent) => agent.id.startsWith("reviewer-"))
    const workers = () => subagents().filter((agent) => !agent.id.startsWith("reviewer-"))

    const [open, setOpen] = createSignal<Record<Section, boolean>>({
      primary: true,
      workers: true,
      reviewers: false,
    })
    const toggle = (section: Section) => setOpen((state) => ({ ...state, [section]: !state[section] }))

    const activeModel = (agent: AgentInfo, sessionID: string): string => {
      const session = context.data.session.get(sessionID)
      if (session?.agent === agent.id && session.model) return modelName(session.model, models())
      if (agent.model) return modelName(agent.model, models())
      return "inherit"
    }

    const running = (sessionID: string): SessionInfo[] => {
      const result: SessionInfo[] = []
      for (const id of context.data.session.family(sessionID)) {
        if (id === sessionID) continue
        const session = context.data.session.get(id)
        if (!session || !session.parentID) continue
        if (context.data.session.status(id) !== "running") continue
        result.push(session)
      }
      return result
    }

    const header = (section: Section, title: string, count: () => number) => (
      <box
        width="100%"
        onMouseDown={(event) => {
          if (event.button !== 0 || event.isDragging) return
          toggle(section)
        }}
      >
        <text fg={context.theme.text.faint} selectable={false}>
          {`${open()[section] ? "▾" : "▸"} ${title} ${count()}`}
        </text>
      </box>
    )

    const row = (agent: AgentInfo, sessionID: string) => {
      const active = () => context.data.session.get(sessionID)?.agent === agent.id
      return (
        <box flexDirection="row" width="100%" justifyContent="space-between" columnGap={1}>
          <box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
            <text
              wrapMode="none"
              flexShrink={0}
              fg={active() ? context.theme.text.base : context.theme.text.faint}
              selectable={false}
            >
              {active() ? "● " : "  "}
            </text>
            <text
              wrapMode="none"
              fg={active() ? (agent.color ?? context.theme.text.base) : context.theme.text.muted}
              selectable={false}
            >
              {truncate(agent.name, NAME_WIDTH)}
            </text>
          </box>
          <box flexShrink={0}>
            <text wrapMode="none" fg={context.theme.text.faint} selectable={false}>
              {truncate(activeModel(agent, sessionID), MODEL_WIDTH)}
            </text>
          </box>
        </box>
      )
    }

    const runningRow = (session: SessionInfo) => {
      const agent = agents().find((candidate) => candidate.id === session.agent)
      const name = agent?.name ?? session.agent ?? "unknown"
      const model = session.model
        ? modelName(session.model, models())
        : agent?.model
          ? modelName(agent.model, models())
          : "inherit"
      return (
        <box flexDirection="row" width="100%" justifyContent="space-between" columnGap={1}>
          <box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
            <text wrapMode="none" flexShrink={0} fg={context.theme.text.faint} selectable={false}>
              {"  "}
            </text>
            <text wrapMode="none" fg={agent?.color ?? context.theme.text.base} selectable={false}>
              {truncate(name, NAME_WIDTH)}
            </text>
          </box>
          <box flexShrink={0}>
            <text wrapMode="none" fg={context.theme.text.faint} selectable={false}>
              {truncate(model, MODEL_WIDTH)}
            </text>
          </box>
        </box>
      )
    }

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <box flexDirection="column" gap={1} width="100%">
          <text fg={context.theme.text.muted} selectable={false}>AGENTS & MODELS</text>
          <box flexDirection="column" width="100%">
            {header("primary", "PRIMARY", () => primary().length)}
            <Show when={open().primary}>
              <For each={primary()}>{(agent) => row(agent, sessionID)}</For>
            </Show>
          </box>
          <box flexDirection="column" width="100%">
            {header("workers", "WORKERS", () => workers().length)}
            <Show when={open().workers}>
              <For each={workers()}>{(agent) => row(agent, sessionID)}</For>
            </Show>
          </box>
          <box flexDirection="column" width="100%">
            {header("reviewers", "REVIEWERS", () => reviewers().length)}
            <Show when={open().reviewers}>
              <For each={reviewers()}>{(agent) => row(agent, sessionID)}</For>
            </Show>
          </box>
          <Show when={running(sessionID).length > 0}>
            <box flexDirection="column" width="100%">
              <text fg={context.theme.text.faint} selectable={false}>{`RUNNING ${running(sessionID).length}`}</text>
              <For each={running(sessionID)}>{(session) => runningRow(session)}</For>
            </box>
          </Show>
        </box>
      ),
    })

    const offAgent = context.data.on("agent.updated", () => {
      context.data.location.agent.invalidate(location)
      void context.data.location.agent.sync(location).catch(() => undefined)
    })
    const offModel = context.data.on("model.updated", () => {
      context.data.location.model.invalidate(location)
      void context.data.location.model.sync(location).catch(() => undefined)
    })

    return () => {
      unregister()
      offAgent()
      offModel()
    }
  },
})
