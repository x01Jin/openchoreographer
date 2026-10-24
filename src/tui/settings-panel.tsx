import type { AgentInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import type { Store } from "solid-js/store"
import { TextAttributes } from "@opentui/core"
import type { ScrollBoxRenderable } from "@opentui/core"
import { STEPS_STEP, clampSteps } from "../shared/settings"
import type { ChoreographerSettings } from "../shared/settings"
import { FLOW, agentColor, truncate } from "./format"

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

export type SettingsRow =
  | { kind: "animation"; key: "todo" | "running"; label: string }
  | { kind: "ui"; key: "todos" | "roster"; label: string }
  | { kind: "agent"; id: string; label: string }

export type SettingsPanelProps = {
  context: Context
  settings: Store<ChoreographerSettings>
  managed: () => string[]
  defaults: () => Record<string, number | null>
  online: () => boolean
  agentById: (id: string) => AgentInfo | undefined
  saveSteps: (id: string, value: number) => void
  resetSteps: (id: string) => void
  toggleAnimation: (key: "todo" | "running") => void
  toggleUi: (key: "todos" | "roster") => void
  flushSteps: () => void
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [selected, setSelected] = createSignal(0)
  onCleanup(() => {
    props.flushSteps()
  })
  let scrollRef: ScrollBoxRenderable | undefined
  const rows = createMemo((): SettingsRow[] => {
    const list: SettingsRow[] = [
      { kind: "animation", key: "todo", label: "TODO animations" },
      { kind: "animation", key: "running", label: "RUNNING animations" },
      { kind: "ui", key: "todos", label: "TODO panel" },
      { kind: "ui", key: "roster", label: "Agent roster" },
    ]
    for (const id of props.managed()) list.push({ kind: "agent", id, label: truncate(id, 18) })
    return list
  })
  const viewportHeight = () => Math.max(4, Math.floor((props.context.renderer.height || 32) * 0.5) - 4)
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
    const effective = props.settings.steps[id] ?? props.defaults()[id] ?? props.agentById(id)?.steps ?? null
    props.saveSteps(id, clampSteps((effective ?? 0) + delta))
  }
  const adjust = (delta: number) => {
    const row = rows()[current()]
    if (row?.kind === "agent") adjustRow(row.id, delta)
  }
  const act = () => {
    const row = rows()[current()]
    if (row?.kind === "animation") props.toggleAnimation(row.key)
    else if (row?.kind === "ui") props.toggleUi(row.key)
  }
  const reset = () => {
    const row = rows()[current()]
    if (row?.kind === "agent") props.resetSteps(row.id)
  }
  props.context.keymap.layer(() => ({
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
      { bind: "escape", run: () => props.context.ui.dialog.clear() },
    ],
  }))
  const rowLine = (row: SettingsRow, index: number) => {
    const active = () => index === current()
    const marker = () => (active() ? "▸ " : "  ")
    const select = () => setSelected(index)
    const accent = row.kind === "animation" ? FLOW[0] : row.kind === "ui" ? FLOW[1] : agentColor(props.agentById(row.id), row.id)
    const label = (
      <box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
        <text wrapMode="none" fg={accent} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
          {`${marker()}${row.label}`}
        </text>
      </box>
    )
    if (row.kind === "animation" || row.kind === "ui") {
      const on = () => row.kind === "animation" ? props.settings.animations[row.key] : (props.settings.ui?.[row.key] ?? true)
      const toggleRow = () => {
        if (row.kind === "animation") props.toggleAnimation(row.key)
        else props.toggleUi(row.key)
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
    const override = () => props.settings.steps[row.id]
    const file = () => props.defaults()[row.id]
    const effective = () => props.settings.steps[row.id] ?? props.defaults()[row.id] ?? props.agentById(row.id)?.steps ?? null
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
            <text fg={props.context.theme.text.faint} selectable={false}>{`default ${file()}`}</text>
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
        <text fg={props.context.theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>Choreographer settings</text>
        <box height={1} onMouseDown={(event) => { if (event.button === 0) props.context.ui.dialog.clear() }}>
          <text fg={props.context.theme.text.muted} attributes={TextAttributes.BOLD} selectable={false}>[esc]</text>
        </box>
      </box>
      <box width="100%" overflow="hidden">
        <text fg={props.context.theme.text.faint} wrapMode="none" selectable={false}>{"─".repeat(200)}</text>
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
        <text fg={props.context.theme.text.faint} wrapMode="none" selectable={false}>{"─".repeat(200)}</text>
      </box>
      <text fg={props.context.theme.text.faint} wrapMode="none" selectable={false}>↑↓ move · ←→ ±5 · enter toggle · r reset</text>
      <text fg={props.context.theme.text.faint} wrapMode="none" selectable={false}>click to select · wheel to scroll · − / + adjusts</text>
      <text fg={props.online() ? "#a6e3a1" : "#f5a97f"} selectable={false}>
        {props.online() ? "plugin connected" : "plugin unreachable: local only"}
      </text>
    </box>
  )
}
