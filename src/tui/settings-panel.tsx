import type { AgentInfo, ModelInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import type { Store } from "solid-js/store"
import { TextAttributes } from "@opentui/core"
import type { ScrollBoxRenderable, InputRenderable } from "@opentui/core"
import { PARALLEL_DEFAULT, PARALLEL_MAX, PARALLEL_MIN, STEPS_STEP, clampSteps } from "../shared/settings"
import type { ChoreographerSettings, ModelSettings } from "../shared/settings"
import { MODEL_GROUPS, ORCHESTRATOR_ID, SUBAGENT_IDS } from "../shared/agents"
import { FLOW, agentColor, truncate } from "./format"

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

type SettingsRow =
  | { kind: "animation"; key: "todo" | "running"; label: string }
  | { kind: "ui"; key: "todos" | "roster"; label: string }
  | { kind: "maxParallel"; label: string }
  | { kind: "agent"; id: string; label: string }
  | { kind: "primaryModel"; id: string; label: string; group: "workers" | "reviewers" }
  | { kind: "primaryBulk"; group: "workers" | "reviewers"; label: string }
  | { kind: "fallbackModel"; id: string; label: string; group: "workers" | "reviewers" }
  | { kind: "fallbackBulk"; group: "workers" | "reviewers"; label: string }

type SettingsPanelProps = {
  context: Context
  settings: Store<ChoreographerSettings>
  managed: () => string[]
  defaults: () => Record<string, number | null>
  online: () => boolean
  agentById: (id: string) => AgentInfo | undefined
  saveSteps: (id: string, value: number) => void
  resetSteps: (id: string) => void
  saveMaxParallel: (value: number) => void
  toggleAnimation: (key: "todo" | "running") => void
  toggleUi: (key: "todos" | "roster") => void
  flushSteps: () => void
  catalog: () => ModelInfo[]
  modelSettings: () => ModelSettings
  configured: () => Record<string, string | null>
  subagents: () => string[]
  disabled: () => string[]
  toggleAgent: (id: string) => void
  savePrimary: (ids: string[], ref: string | null) => Promise<boolean>
  saveFallback: (ids: string[], refs: string[] | null) => Promise<boolean>
}

type PickerState =
  | { mode: "primary"; ids: string[]; group: "workers" | "reviewers" | null; origin: number; staged: string | null; opened: string | null; custom: boolean }
  | { mode: "fallback"; ids: string[]; group: "workers" | "reviewers" | null; origin: number; staged: string | null; opened: string | null; custom: boolean }

const SECTIONS: Record<SettingsRow["kind"], { title: string; color: string }> = {
  animation: { title: "ANIMATIONS", color: FLOW[0] },
  ui: { title: "INTERFACE", color: FLOW[1] },
  maxParallel: { title: "INTERFACE", color: FLOW[1] },
  agent: { title: "SUBAGENT TOGGLE AND STEPS", color: "#c6a0f6" },
  primaryModel: { title: "PRIMARY MODELS", color: "#94e2d5" },
  primaryBulk: { title: "PRIMARY MODELS", color: "#94e2d5" },
  fallbackModel: { title: "FALLBACK MODELS", color: "#f5c2e7" },
  fallbackBulk: { title: "FALLBACK MODELS", color: "#f5c2e7" },
}

function truncateMiddle(value: string, width: number): string {
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
  if (clean.length <= width) return clean
  if (width <= 0) return ""
  if (width === 1) return "…"
  const keep = width - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${clean.slice(0, head)}…${clean.slice(clean.length - tail)}`
}

function sectionOf(row: SettingsRow | undefined): string | null {
  if (!row) return null
  if (row.kind === "maxParallel") return "ui"
  if (row.kind === "primaryModel" || row.kind === "primaryBulk") return "primary"
  if (row.kind === "fallbackModel" || row.kind === "fallbackBulk") return "fallback"
  return row.kind
}

function groupOf(row: SettingsRow | undefined): string | null {
  if (!row) return null
  if (row.kind === "primaryModel" || row.kind === "primaryBulk" || row.kind === "fallbackModel" || row.kind === "fallbackBulk") return row.group
  return null
}

function groupLabelFor(group: string): string {
  return MODEL_GROUPS.find((entry) => entry.id === group)?.label ?? group.toUpperCase()
}

function listsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => b[index] === value)
}

function stagedRef(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [selected, setSelected] = createSignal(0)
  const [picker, setPicker] = createSignal<PickerState | null>(null)
  const [pickerSel, setPickerSel] = createSignal(0)
  const [query, setQuery] = createSignal("")
  onCleanup(() => {
    props.flushSteps()
  })
  let scrollRef: ScrollBoxRenderable | undefined
  let searchRef: InputRenderable | undefined
  let suppressInput = false
  let savedScrollTop = 0
  const memberIdsFor = (group: string): string[] => {
    const entry = MODEL_GROUPS.find((item) => item.id === group)
    if (!entry) return []
    const present = new Set(props.subagents())
    const members = entry.ids.filter((id) => present.has(id))
    return members.length > 0 ? [...members] : [...entry.ids]
  }
  const rows = createMemo((): SettingsRow[] => {
    const list: SettingsRow[] = [
      { kind: "animation", key: "todo", label: "TODO animations" },
      { kind: "animation", key: "running", label: "RUNNING animations" },
      { kind: "ui", key: "todos", label: "TODO panel" },
      { kind: "ui", key: "roster", label: "Agent roster" },
      { kind: "maxParallel", label: "Max parallel" },
    ]
    for (const id of props.managed()) list.push({ kind: "agent", id, label: truncate(id, 18) })
    for (const group of MODEL_GROUPS) {
      list.push({ kind: "primaryBulk", group: group.id, label: truncate(`all ${group.id}`, 18) })
      for (const id of memberIdsFor(group.id)) list.push({ kind: "primaryModel", id, label: truncate(id, 18), group: group.id })
    }
    for (const id of props.subagents()) {
      if (MODEL_GROUPS.some((group) => group.ids.includes(id))) continue
      const fallbackGroup = MODEL_GROUPS[0]?.id ?? "workers"
      list.push({ kind: "primaryModel", id, label: truncate(id, 18), group: fallbackGroup })
    }
    for (const group of MODEL_GROUPS) {
      list.push({ kind: "fallbackBulk", group: group.id, label: truncate(`all ${group.id}`, 18) })
      for (const id of memberIdsFor(group.id)) list.push({ kind: "fallbackModel", id, label: truncate(id, 18), group: group.id })
    }
    for (const id of props.subagents()) {
      if (MODEL_GROUPS.some((group) => group.ids.includes(id))) continue
      const fallbackGroup = MODEL_GROUPS[0]?.id ?? "workers"
      list.push({ kind: "fallbackModel", id, label: truncate(id, 18), group: fallbackGroup })
    }
    return list
  })
  const modelIndex = createMemo((): Map<string, string> => {
    const index = new Map<string, string>()
    for (const model of props.catalog()) {
      const label = model?.name?.trim() || `${model.providerID}/${model.id}`
      index.set(`${model.providerID}/${model.id}`, label)
      if (model.modelID && model.modelID !== model.id) index.set(`${model.providerID}/${model.modelID}`, label)
    }
    return index
  })
  const nameForRef = (ref: string): string => modelIndex().get(ref) ?? ref
  const listText = (list: readonly string[]): string => {
    if (list.length === 0) return "none"
    const names = list.slice(0, 2).map((ref) => nameForRef(ref))
    const joined = list.length > 2 ? `${names.join(", ")} +${list.length - 2}` : names.join(", ")
    return truncateMiddle(joined, 26)
  }
  const primaryEffective = (id: string): string | null =>
    props.modelSettings().primary[id] ?? props.configured()[id] ?? null
  const fallbackEffective = (id: string): string[] =>
    props.modelSettings().fallback[id] ?? []
  const primaryBulkValue = (ids: readonly string[]): string => {
    if (ids.length === 0) return "inherit"
    const first = primaryEffective(ids[0])
    if (ids.every((id) => primaryEffective(id) === first)) {
      if (first === null) return "inherit"
      return truncateMiddle(nameForRef(first), 26)
    }
    return "custom"
  }
  const fallbackBulkValue = (ids: readonly string[]): string => {
    if (ids.length === 0) return "none"
    const first = fallbackEffective(ids[0])
    if (ids.every((id) => listsEqual(fallbackEffective(id), first))) return listText(first)
    return "custom"
  }
  const groups = createMemo((): { provider: string; items: ModelInfo[] }[] => {
    const seen = new Map<string, ModelInfo[]>()
    for (const model of props.catalog()) {
      const bucket = seen.get(model.providerID)
      if (bucket) bucket.push(model)
      else seen.set(model.providerID, [model])
    }
    return [...seen.entries()].map(([provider, items]) => ({ provider, items }))
  })
  const flatRefs = createMemo((): string[] => groups().flatMap((group) => group.items.map((item) => `${item.providerID}/${item.id}`)))
  const filteredGroups = createMemo((): { provider: string; items: ModelInfo[] }[] => {
    const q = query().trim().toLowerCase()
    if (q.length === 0) return groups()
    const out: { provider: string; items: ModelInfo[] }[] = []
    for (const group of groups()) {
      const items = group.items.filter((item) => {
        const ref = `${item.providerID}/${item.id}`
        const label = (item?.name?.trim() || ref).toLowerCase()
        return label.includes(q) || item.providerID.toLowerCase().includes(q) || ref.toLowerCase().includes(q)
      })
      if (items.length > 0) out.push({ provider: group.provider, items })
    }
    return out
  })
  const visibleRefs = createMemo((): string[] => filteredGroups().flatMap((group) => group.items.map((item) => `${item.providerID}/${item.id}`)))
  const visibleIndex = createMemo((): Map<string, number> => {
    const index = new Map<string, number>()
    visibleRefs().forEach((ref, at) => {
      if (!index.has(ref)) index.set(ref, at)
    })
    return index
  })
  const viewportHeight = () => Math.max(4, Math.floor((props.context.renderer.height || 32) * 0.5) - 4)
  const current = () => Math.min(selected(), Math.max(0, rows().length - 1))
  const reveal = (index: number) => {
    const id = `choreographer-row-${index}`
    queueMicrotask(() => scrollRef?.scrollChildIntoView(id))
  }
  const revealPick = (flat: number) => {
    const id = `choreographer-pick-${flat}`
    queueMicrotask(() => scrollRef?.scrollChildIntoView(id))
  }
  const move = (delta: number) => {
    const count = rows().length
    if (count === 0) return
    const next = Math.min(count - 1, Math.max(0, current() + delta))
    setSelected(next)
    reveal(next)
  }
  const pickerMove = (delta: number) => {
    const refs = visibleRefs()
    if (refs.length === 0) return
    const next = Math.min(refs.length - 1, Math.max(0, pickerSel() + delta))
    setPickerSel(next)
    revealPick(next)
    const state = picker()
    if (state === null) return
    if (next < 0 || next >= refs.length) return
    const ref = refs[next]
    if (state.staged === ref) return
    setPicker({ ...state, ids: [...state.ids], staged: ref })
  }
  const applyQuery = (next: string, stage = true) => {
    if (suppressInput || next === query()) return
    setQuery(next)
    const refs = visibleRefs()
    const state = picker()
    let staged = state?.staged ?? null
    if (stage && state !== null && refs.length > 0 && (staged === null || !refs.includes(staged))) {
      staged = refs[0]
      setPicker({ ...state, ids: [...state.ids], staged })
    }
    const at = staged === null ? 0 : refs.indexOf(staged)
    const sel = at < 0 ? 0 : at
    setPickerSel(sel)
    revealPick(sel)
  }
  const adjustRow = (id: string, delta: number) => {
    const effective = props.settings.steps[id] ?? props.defaults()[id] ?? props.agentById(id)?.steps ?? null
    props.saveSteps(id, clampSteps((effective ?? 0) + delta))
  }
  const adjustParallel = (delta: number) => {
    const effective = props.settings.maxParallel
    const next = Math.min(PARALLEL_MAX, Math.max(PARALLEL_MIN, effective + delta))
    if (next !== effective) props.saveMaxParallel(next)
  }
  const adjust = (delta: number) => {
    const row = rows()[current()]
    if (row?.kind === "agent") adjustRow(row.id, delta * STEPS_STEP)
    else if (row?.kind === "maxParallel") adjustParallel(delta)
  }
  const openPicker = (row: SettingsRow, index: number) => {
    if (row.kind !== "primaryModel" && row.kind !== "fallbackModel" && row.kind !== "primaryBulk" && row.kind !== "fallbackBulk") return
    const isPrimary = row.kind === "primaryModel" || row.kind === "primaryBulk"
    const isBulk = row.kind === "primaryBulk" || row.kind === "fallbackBulk"
    const ids = isBulk ? memberIdsFor(row.group) : [(row as { id: string }).id]
    if (ids.length === 0) return
    try {
      savedScrollTop = scrollRef?.scrollTop ?? 0
    } catch {
      savedScrollTop = 0
    }
    setQuery("")
    if (searchRef) {
      try {
        searchRef.value = ""
      } catch {
        // input remounts on open; the fresh value applies
      }
    }
    const startAt = (staged: string | null): number => {
      if (staged === null) return 0
      const found = visibleRefs().indexOf(staged)
      return found < 0 ? 0 : found
    }
    const group = isBulk ? (row as { group: "workers" | "reviewers" }).group : null
    if (isPrimary) {
      if (!isBulk) {
        const single = ids[0]
        const staged = stagedRef(primaryEffective(single))
        const at = startAt(staged)
        setPickerSel(at)
        setPicker({ mode: "primary", ids, group, origin: index, staged, opened: staged, custom: false })
        revealPick(at)
      } else {
        const effectives = ids.map((id) => primaryEffective(id))
        const uniform = ids.length > 0 && effectives.every((value) => value === effectives[0])
        const shared = stagedRef(uniform ? effectives[0] : null)
        const at = startAt(shared)
        setPickerSel(at)
        setPicker({ mode: "primary", ids, group, origin: index, staged: shared, opened: shared, custom: !uniform })
        revealPick(at)
      }
    } else {
      if (!isBulk) {
        const single = ids[0]
        const staged = stagedRef(props.modelSettings().fallback[single]?.[0] ?? null)
        const at = startAt(staged)
        setPickerSel(at)
        setPicker({ mode: "fallback", ids, group, origin: index, staged, opened: staged, custom: false })
        revealPick(at)
      } else {
        const effectives = ids.map((id) => fallbackEffective(id))
        const uniform = ids.length > 0 && effectives.every((list) => listsEqual(list, effectives[0]))
        const shared = stagedRef(uniform ? effectives[0][0] : null)
        const at = startAt(shared)
        setPickerSel(at)
        setPicker({ mode: "fallback", ids, group, origin: index, staged: shared, opened: shared, custom: !uniform })
        revealPick(at)
      }
    }
  }
  const focusRowForPicker = (state: PickerState): number => {
    if (state.group !== null) {
      const want = state.mode === "primary" ? "primaryBulk" : "fallbackBulk"
      const found = rows().findIndex((row) => row.kind === want && (row as { group: string }).group === state.group)
      if (found >= 0) return found
    } else {
      const want = state.mode === "primary" ? "primaryModel" : "fallbackModel"
      const single = state.ids[0]
      const found = rows().findIndex((row) => row.kind === want && (row as { id: string }).id === single)
      if (found >= 0) return found
    }
    return Math.min(state.origin, Math.max(0, rows().length - 1))
  }
  const restoreScroll = () => {
    const top = savedScrollTop
    const node = scrollRef
    setTimeout(() => {
      if (picker() !== null) return
      const target = scrollRef ?? node
      if (!target) return
      try {
        target.scrollTop = top
      } catch {
        // panel closed or renderer gone; leave the list where it is
      }
    }, 16)
  }
  const exitPicker = (state: PickerState) => {
    setPicker(null)
    const next = focusRowForPicker(state)
    setSelected(next)
    reveal(next)
    restoreScroll()
  }
  const confirmPicker = () => {
    const state = picker()
    if (state === null) return
    if (visibleRefs().length === 0) return
    if (state.staged === state.opened) {
      exitPicker(state)
      return
    }
    if (!props.online() || props.catalog().length === 0) return
    if (state.mode === "primary") {
      const staged = state.staged
      const ids = [...state.ids]
      void props.savePrimary(ids, staged).then((ok) => {
        if (ok && picker() === state) exitPicker(state)
      })
    } else {
      const staged = state.staged
      const ids = [...state.ids]
      void props.saveFallback(ids, staged === null ? null : [staged]).then((ok) => {
        if (ok && picker() === state) exitPicker(state)
      })
    }
  }
  const clickEntry = (flat: number) => {
    const state = picker()
    if (state === null || !props.online() || props.catalog().length === 0) return
    const refs = visibleRefs()
    if (flat < 0 || flat >= refs.length) return
    const ref = refs[flat]
    setPickerSel(flat)
    setPicker({ ...state, ids: [...state.ids], staged: ref })
    confirmPicker()
  }
  const pressConfirm = () => {
    if (picker() !== null) {
      confirmPicker()
      return
    }
    const row = rows()[current()]
    if (row?.kind === "animation") props.toggleAnimation(row.key)
    else if (row?.kind === "ui") props.toggleUi(row.key)
    else if (row?.kind === "primaryModel" || row?.kind === "fallbackModel" || row?.kind === "primaryBulk" || row?.kind === "fallbackBulk") openPicker(row, current())
  }
  const pressSpace = () => {
    if (picker() !== null) return
    const row = rows()[current()]
    if (row?.kind === "agent") {
      if (row.id === ORCHESTRATOR_ID) return
      props.toggleAgent(row.id)
      return
    }
    pressConfirm()
  }
  const pressClear = () => {
    const row = rows()[current()]
    if (row?.kind === "agent") props.resetSteps(row.id)
    else if (row?.kind === "maxParallel") props.saveMaxParallel(PARALLEL_DEFAULT)
    else if (row?.kind === "primaryModel") void props.savePrimary([row.id], null)
    else if (row?.kind === "fallbackModel") void props.saveFallback([row.id], null)
    else if (row?.kind === "primaryBulk") {
      const ids = memberIdsFor(row.group)
      if (!ids.some((id) => props.modelSettings().primary[id] !== undefined)) return
      void props.savePrimary(ids, null)
    } else if (row?.kind === "fallbackBulk") {
      const ids = memberIdsFor(row.group)
      if (!ids.some((id) => props.modelSettings().fallback[id] !== undefined)) return
      void props.saveFallback(ids, null)
    }
  }
  const pressEscape = () => {
    const state = picker()
    if (state === null) {
      props.context.ui.dialog.clear()
      return
    }
    if (query().length > 0) {
      applyQuery("", false)
      if (searchRef) {
        suppressInput = true
        try {
          searchRef.value = ""
        } catch {
          // input stays mounted; the query reset drives the list
        } finally {
          suppressInput = false
        }
      }
      return
    }
    exitPicker(state)
  }
  props.context.keymap.layer(() => {
    if (picker() !== null) {
      return {
        mode: "global",
        priority: 10,
        commands: [
          { bind: "up", run: () => pickerMove(-1) },
          { bind: "down", run: () => pickerMove(1) },
          { bind: "return", run: () => pressConfirm() },
          { bind: "escape", run: () => pressEscape() },
        ],
      }
    }
    return {
      mode: "global",
      priority: 10,
      commands: [
        { bind: "up", run: () => move(-1) },
        { bind: "down", run: () => move(1) },
        { bind: "left", run: () => adjust(-1) },
        { bind: "right", run: () => adjust(1) },
        { bind: "return", run: () => pressConfirm() },
        { bind: "space", run: () => pressSpace() },
        { bind: "r", run: () => pressClear() },
        { bind: "escape", run: () => pressEscape() },
      ],
    }
  })
  const pickerTitle = () => {
    const state = picker()
    if (state === null) return "Choreographer settings"
    if (state.group !== null) {
      const count = state.ids.length
      return state.mode === "primary" ? `primary model — ${state.group} (${count})` : `fallback model — ${state.group} (${count})`
    }
    const single = state.ids[0] ?? ""
    return state.mode === "primary" ? `primary model — ${single}` : `fallback model — ${single}`
  }
  const rowLine = (row: SettingsRow, index: number) => {
    const active = () => index === current()
    const marker = () => (active() ? "▸ " : "  ")
    const select = () => setSelected(index)
    const label = (accent: string) => (
      <box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
        <text wrapMode="none" fg={accent} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
          {`${marker()}${row.label}`}
        </text>
      </box>
    )
    if (row.kind === "animation" || row.kind === "ui") {
      const accent = row.kind === "animation" ? FLOW[0] : FLOW[1]
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
          {label(accent)}
          <text fg={on() ? "#a6e3a1" : "#f5a97f"} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
            {on() ? "on" : "off"}
          </text>
        </box>
      )
    }
    if (row.kind === "maxParallel") {
      const accent = FLOW[1]
      const effective = () => props.settings.maxParallel
      const changed = () => props.settings.maxParallel !== PARALLEL_DEFAULT
      const atMin = () => effective() <= PARALLEL_MIN
      const atMax = () => effective() >= PARALLEL_MAX
      const nudge = (delta: number) => (event: { button: number; isDragging?: boolean; stopPropagation: () => void }) => {
        if (event.button !== 0 || event.isDragging) return
        event.stopPropagation()
        select()
        adjustParallel(delta)
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
          {label(accent)}
          <box flexDirection="row" columnGap={1} flexShrink={0}>
            <Show when={changed()}>
              <text fg={props.context.theme.text.faint} selectable={false}>{`default ${PARALLEL_DEFAULT}`}</text>
            </Show>
            <box onMouseDown={nudge(-1)}>
              <text fg={atMin() ? props.context.theme.text.faint : accent} selectable={false}>−</text>
            </box>
            <text
              fg={accent}
              attributes={active() || changed() ? TextAttributes.BOLD : undefined}
              selectable={false}
            >
              {`${effective()}`}
            </text>
            <box onMouseDown={nudge(1)}>
              <text fg={atMax() ? props.context.theme.text.faint : accent} selectable={false}>+</text>
            </box>
          </box>
        </box>
      )
    }
    if (row.kind === "agent") {
      const isOrchestrator = row.id === ORCHESTRATOR_ID
      const off = () => !isOrchestrator && props.disabled().includes(row.id)
      const accent = agentColor(props.agentById(row.id), row.id)
      const idColor = () => (off() ? props.context.theme.text.faint : accent)
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
      const toggleBox = (event: { button: number; isDragging?: boolean; stopPropagation: () => void }) => {
        if (event.button !== 0 || event.isDragging) return
        event.stopPropagation()
        select()
        props.toggleAgent(row.id)
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
          <box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden" columnGap={1}>
            <text fg={props.context.theme.text.base} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
              {marker()}
            </text>
            <Show when={!isOrchestrator}>
              <box onMouseDown={toggleBox}>
                <text fg={off() ? props.context.theme.text.faint : "#a6e3a1"} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
                  {off() ? "[ ]" : "[x]"}
                </text>
              </box>
            </Show>
            <text wrapMode="none" fg={idColor()} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
              {row.label}
            </text>
            <Show when={off()}>
              <text fg="#f5a97f" selectable={false}>off</text>
            </Show>
          </box>
          <box flexDirection="row" columnGap={1} flexShrink={0}>
            <Show when={changed()}>
              <text fg={props.context.theme.text.faint} selectable={false}>{`default ${file()}`}</text>
            </Show>
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
          </box>
        </box>
      )
    }
    if (row.kind === "primaryBulk") {
      const accent = SECTIONS[row.kind].color
      const open = () => openPicker(row, index)
      const ids = () => memberIdsFor(row.group)
      const valueText = () => primaryBulkValue(ids())
      return (
        <box
          flexDirection="row"
          width="100%"
          justifyContent="space-between"
          columnGap={2}
          onMouseDown={(event) => {
            if (event.button !== 0 || event.isDragging) return
            select()
            open()
          }}
        >
          {label(accent)}
          <text fg={accent} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
            {valueText()}
          </text>
        </box>
      )
    }
    if (row.kind === "fallbackBulk") {
      const accent = SECTIONS[row.kind].color
      const open = () => openPicker(row, index)
      const ids = () => memberIdsFor(row.group)
      const valueText = () => fallbackBulkValue(ids())
      return (
        <box
          flexDirection="row"
          width="100%"
          justifyContent="space-between"
          columnGap={2}
          onMouseDown={(event) => {
            if (event.button !== 0 || event.isDragging) return
            select()
            open()
          }}
        >
          {label(accent)}
          <text fg={accent} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
            {valueText()}
          </text>
        </box>
      )
    }
    const accent = agentColor(props.agentById(row.id), row.id)
    const open = () => openPicker(row, index)
    if (row.kind === "primaryModel") {
      const valueText = () => {
        const shown = primaryEffective(row.id)
        if (shown === null) return "inherit"
        return truncateMiddle(nameForRef(shown), 26)
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
            open()
          }}
        >
          {label(accent)}
          <text fg={accent} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
            {valueText()}
          </text>
        </box>
      )
    }
    const valueText = () => listText(fallbackEffective(row.id))
    return (
      <box
        flexDirection="row"
        width="100%"
        justifyContent="space-between"
        columnGap={2}
        onMouseDown={(event) => {
          if (event.button !== 0 || event.isDragging) return
          select()
          open()
        }}
      >
        {label(accent)}
        <text fg={accent} attributes={active() ? TextAttributes.BOLD : undefined} selectable={false}>
          {valueText()}
        </text>
      </box>
    )
  }
  const section = (title: string, colour: string) => (
    <box marginTop={1}>
      <text fg={colour} attributes={TextAttributes.BOLD} selectable={false}>{title}</text>
    </box>
  )
  const subheader = (title: string) => (
    <box marginTop={1}>
      <text fg={props.context.theme.text.faint} attributes={TextAttributes.BOLD} selectable={false}>{title}</text>
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
        <text fg={props.context.theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>{pickerTitle()}</text>
        <box height={1} onMouseDown={(event) => { if (event.button === 0) props.context.ui.dialog.clear() }}>
          <text fg={props.context.theme.text.muted} attributes={TextAttributes.BOLD} selectable={false}>[esc]</text>
        </box>
      </box>
      <box width="100%" overflow="hidden">
        <text fg={props.context.theme.text.faint} wrapMode="none" selectable={false}>{"─".repeat(200)}</text>
      </box>
      <Show when={picker() !== null}>
        <box width="100%" marginTop={1}>
          <input
            ref={(node) => (searchRef = node ?? undefined)}
            width="100%"
            value=""
            placeholder="type to filter models…"
            focused={picker() !== null}
            onInput={(value: string) => applyQuery(value)}
          />
        </box>
      </Show>
      <scrollbox
        ref={(node) => (scrollRef = node ?? undefined)}
        width="100%"
        height={Math.min(picker() === null ? rows().length + 6 : groups().length + flatRefs().length + 3, viewportHeight())}
        marginTop={picker() === null ? 0 : 1}
        scrollY={true}
        scrollX={false}
        stickyScroll={false}
        paddingRight={1}
      >
        <Show
          when={picker() === null}
          fallback={(
            <box flexDirection="column" width="100%">
              <Show when={flatRefs().length === 0}>
                <box marginTop={1}>
                  <text fg={props.context.theme.text.faint} selectable={false}>no models available</text>
                </box>
              </Show>
              <Show when={flatRefs().length > 0 && visibleRefs().length === 0}>
                <box marginTop={1}>
                  <text fg={props.context.theme.text.faint} selectable={false}>{`no matches for "${truncate(query(), 28)}"`}</text>
                </box>
              </Show>
              <For each={filteredGroups()}>
                {(group) => (
                  <box flexDirection="column" width="100%">
                    <box marginTop={1}>
                      <text fg={props.context.theme.text.faint} attributes={TextAttributes.BOLD} selectable={false}>{group.provider}</text>
                    </box>
                    <For each={group.items}>
                      {(item) => {
                        const ref = `${item.providerID}/${item.id}`
                        const flat = visibleIndex().get(ref) ?? -1
                        const entryLabel = item?.name?.trim() || ref
                        const focused = () => flat === pickerSel()
                        const isStaged = () => picker()?.staged === ref
                        return (
                          <box
                            id={`choreographer-pick-${flat}`}
                            flexDirection="row"
                            width="100%"
                            columnGap={1}
                            onMouseDown={(event) => {
                              if (event.button !== 0 || event.isDragging) return
                              clickEntry(flat)
                            }}
                          >
                            <text fg={focused() ? "#c6a0f6" : props.context.theme.text.muted} attributes={focused() ? TextAttributes.BOLD : undefined} selectable={false}>
                              {focused() ? "▸ " : "  "}
                            </text>
                            <text
                              fg={isStaged() ? "#a6e3a1" : props.context.theme.text.base}
                              attributes={focused() || isStaged() ? TextAttributes.BOLD : undefined}
                              selectable={false}
                            >
                              {truncateMiddle(entryLabel, 30)}
                            </text>
                          </box>
                        )
                      }}
                    </For>
                  </box>
                )}
              </For>
            </box>
          )}
        >
          <For each={rows()}>
            {(row, index) => (
              <box id={`choreographer-row-${index()}`} flexDirection="column" width="100%">
                <Show when={sectionOf(rows()[index() - 1]) !== sectionOf(row)}>
                  {section(SECTIONS[row.kind].title, SECTIONS[row.kind].color)}
                </Show>
                <Show when={row.kind === "agent" && (index() === 0 || rows()[index() - 1]?.kind !== "agent") && SUBAGENT_IDS.every((id) => props.disabled().includes(id))}>
                  <box>
                    <text fg={props.context.theme.text.faint} selectable={false}>all subagents off — orchestrator runs alone</text>
                  </box>
                </Show>
                <Show when={groupOf(row) !== null && groupOf(rows()[index() - 1]) !== groupOf(row)}>
                  {subheader(groupLabelFor(groupOf(row) as string))}
                </Show>
                {rowLine(row, index())}
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
      <box marginTop={1} width="100%" overflow="hidden">
        <text fg={props.context.theme.text.faint} wrapMode="none" selectable={false}>{"─".repeat(200)}</text>
      </box>
      <Show
        when={picker() === null}
        fallback={(
          <box flexDirection="column" width="100%">
            <text fg={props.context.theme.text.faint} wrapMode="none" selectable={false}>↑↓ move · enter confirm · esc clear / back</text>
            <text fg={props.context.theme.text.faint} wrapMode="none" selectable={false}>click confirms · wheel scrolls · type filters</text>
            <Show when={(picker()?.ids.length ?? 0) > 1}>
              <text fg={props.context.theme.text.faint} wrapMode="none" selectable={false}>{`enter applies to all ${picker()?.ids.length} in group`}</text>
            </Show>
          </box>
        )}
      >
        <text fg={props.context.theme.text.faint} wrapMode="none" selectable={false}>↑↓ move · ←→ ±1/±5 · enter pick · space on/off · r reset · esc close</text>
        <text fg={props.context.theme.text.faint} wrapMode="none" selectable={false}>click checkbox toggles · − / + adjusts steps even when off</text>
      </Show>
      <text fg={props.online() ? "#a6e3a1" : "#f5a97f"} selectable={false}>
        {props.online() ? "plugin connected" : "plugin unreachable: local only"}
      </text>
      <Show when={picker() !== null && !props.online()}>
        <text fg={props.context.theme.text.faint} selectable={false}>read-only while offline</text>
      </Show>
    </box>
  )
}
