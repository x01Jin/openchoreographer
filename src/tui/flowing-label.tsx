import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { FLOW } from "./format"

export function FlowingLabel(props: { text: string; animate: boolean }) {
  const [phase, setPhase] = createSignal(0)
  createEffect(() => {
    if (!props.animate) return
    const timer = setInterval(() => setPhase((value) => value + 1), 220)
    onCleanup(() => clearInterval(timer))
  })
  const chars = createMemo(() => Array.from(props.text))
  return (
    <Show
      when={props.animate}
      fallback={
        <text fg={FLOW[0]} selectable={false} attributes={TextAttributes.BOLD}>{props.text}</text>
      }
    >
      <box flexDirection="row">
        <For each={chars()}>
          {(char, index) => (
            <text fg={FLOW[(((index() - phase()) % FLOW.length) + FLOW.length) % FLOW.length]} selectable={false} attributes={TextAttributes.BOLD}>{char}</text>
          )}
        </For>
      </box>
    </Show>
  )
}
