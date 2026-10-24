import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { FLOW } from "./format"

export function FlowingLabel(props: { text: string; animate: boolean }) {
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
