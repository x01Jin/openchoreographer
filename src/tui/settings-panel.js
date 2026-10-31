import { use as _$use } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { For, Show, createMemo, createSignal } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { PARALLEL_DEFAULT, PARALLEL_MAX, PARALLEL_MIN } from "../shared/settings";
import { MODEL_GROUPS, ORCHESTRATOR_ID, SUBAGENT_IDS } from "../shared/agents";
import { FLOW, agentColor, truncate } from "./format";
const SECTIONS = {
  animation: {
    title: "ANIMATIONS",
    color: FLOW[0]
  },
  ui: {
    title: "INTERFACE",
    color: FLOW[1]
  },
  maxParallel: {
    title: "INTERFACE",
    color: FLOW[1]
  },
  agent: {
    title: "SUBAGENT TOGGLE",
    color: "#c6a0f6"
  },
  primaryModel: {
    title: "PRIMARY MODELS",
    color: "#94e2d5"
  },
  primaryBulk: {
    title: "PRIMARY MODELS",
    color: "#94e2d5"
  },
  fallbackModel: {
    title: "FALLBACK MODELS",
    color: "#f5c2e7"
  },
  fallbackBulk: {
    title: "FALLBACK MODELS",
    color: "#f5c2e7"
  }
};
function truncateMiddle(value, width) {
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
  if (clean.length <= width) return clean;
  if (width <= 0) return "";
  if (width === 1) return "…";
  const keep = width - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${clean.slice(0, head)}…${clean.slice(clean.length - tail)}`;
}
function sectionOf(row) {
  if (!row) return null;
  if (row.kind === "maxParallel") return "ui";
  if (row.kind === "primaryModel" || row.kind === "primaryBulk") return "primary";
  if (row.kind === "fallbackModel" || row.kind === "fallbackBulk") return "fallback";
  return row.kind;
}
function groupOf(row) {
  if (!row) return null;
  if (row.kind === "primaryModel" || row.kind === "primaryBulk" || row.kind === "fallbackModel" || row.kind === "fallbackBulk") return row.group;
  return null;
}
function groupLabelFor(group) {
  return MODEL_GROUPS.find(entry => entry.id === group)?.label ?? group.toUpperCase();
}
function listsEqual(a, b) {
  return a.length === b.length && a.every((value, index) => b[index] === value);
}
function stagedRef(value) {
  return typeof value === "string" ? value : null;
}
export function SettingsPanel(props) {
  const [selected, setSelected] = createSignal(0);
  const [picker, setPicker] = createSignal(null);
  const [pickerSel, setPickerSel] = createSignal(0);
  const [query, setQuery] = createSignal("");
  let scrollRef;
  let searchRef;
  let suppressInput = false;
  let savedScrollTop = 0;
  const memberIdsFor = group => {
    const entry = MODEL_GROUPS.find(item => item.id === group);
    if (!entry) return [];
    const present = new Set(props.subagents());
    const members = entry.ids.filter(id => present.has(id));
    return members.length > 0 ? [...members] : [...entry.ids];
  };
  const rows = createMemo(() => {
    const list = [{
      kind: "animation",
      key: "todo",
      label: "TODO animations"
    }, {
      kind: "animation",
      key: "running",
      label: "RUNNING animations"
    }, {
      kind: "ui",
      key: "todos",
      label: "TODO panel"
    }, {
      kind: "ui",
      key: "roster",
      label: "Agent roster"
    }, {
      kind: "maxParallel",
      label: "Max parallel"
    }];
    for (const id of props.managed()) list.push({
      kind: "agent",
      id,
      label: truncate(id, 18)
    });
    for (const group of MODEL_GROUPS) {
      list.push({
        kind: "primaryBulk",
        group: group.id,
        label: truncate(`all ${group.id}`, 18)
      });
      for (const id of memberIdsFor(group.id)) list.push({
        kind: "primaryModel",
        id,
        label: truncate(id, 18),
        group: group.id
      });
    }
    for (const id of props.subagents()) {
      if (MODEL_GROUPS.some(group => group.ids.includes(id))) continue;
      const fallbackGroup = MODEL_GROUPS[0]?.id ?? "workers";
      list.push({
        kind: "primaryModel",
        id,
        label: truncate(id, 18),
        group: fallbackGroup
      });
    }
    for (const group of MODEL_GROUPS) {
      list.push({
        kind: "fallbackBulk",
        group: group.id,
        label: truncate(`all ${group.id}`, 18)
      });
      for (const id of memberIdsFor(group.id)) list.push({
        kind: "fallbackModel",
        id,
        label: truncate(id, 18),
        group: group.id
      });
    }
    for (const id of props.subagents()) {
      if (MODEL_GROUPS.some(group => group.ids.includes(id))) continue;
      const fallbackGroup = MODEL_GROUPS[0]?.id ?? "workers";
      list.push({
        kind: "fallbackModel",
        id,
        label: truncate(id, 18),
        group: fallbackGroup
      });
    }
    return list;
  });
  const modelIndex = createMemo(() => {
    const index = new Map();
    for (const model of props.catalog()) {
      const label = model?.name?.trim() || `${model.providerID}/${model.id}`;
      index.set(`${model.providerID}/${model.id}`, label);
      if (model.modelID && model.modelID !== model.id) index.set(`${model.providerID}/${model.modelID}`, label);
    }
    return index;
  });
  const nameForRef = ref => modelIndex().get(ref) ?? ref;
  const listText = list => {
    if (list.length === 0) return "none";
    const names = list.slice(0, 2).map(ref => nameForRef(ref));
    const joined = list.length > 2 ? `${names.join(", ")} +${list.length - 2}` : names.join(", ");
    return truncateMiddle(joined, 26);
  };
  const primaryEffective = id => props.modelSettings().primary[id] ?? props.configured()[id] ?? null;
  const fallbackEffective = id => props.modelSettings().fallback[id] ?? [];
  const primaryBulkValue = ids => {
    if (ids.length === 0) return "inherit";
    const first = primaryEffective(ids[0]);
    if (ids.every(id => primaryEffective(id) === first)) {
      if (first === null) return "inherit";
      return truncateMiddle(nameForRef(first), 26);
    }
    return "custom";
  };
  const fallbackBulkValue = ids => {
    if (ids.length === 0) return "none";
    const first = fallbackEffective(ids[0]);
    if (ids.every(id => listsEqual(fallbackEffective(id), first))) return listText(first);
    return "custom";
  };
  const groups = createMemo(() => {
    const seen = new Map();
    for (const model of props.catalog()) {
      const bucket = seen.get(model.providerID);
      if (bucket) bucket.push(model);else seen.set(model.providerID, [model]);
    }
    return [...seen.entries()].map(([provider, items]) => ({
      provider,
      items
    }));
  });
  const flatRefs = createMemo(() => groups().flatMap(group => group.items.map(item => `${item.providerID}/${item.id}`)));
  const filteredGroups = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (q.length === 0) return groups();
    const out = [];
    for (const group of groups()) {
      const items = group.items.filter(item => {
        const ref = `${item.providerID}/${item.id}`;
        const label = (item?.name?.trim() || ref).toLowerCase();
        return label.includes(q) || item.providerID.toLowerCase().includes(q) || ref.toLowerCase().includes(q);
      });
      if (items.length > 0) out.push({
        provider: group.provider,
        items
      });
    }
    return out;
  });
  const visibleRefs = createMemo(() => filteredGroups().flatMap(group => group.items.map(item => `${item.providerID}/${item.id}`)));
  const visibleIndex = createMemo(() => {
    const index = new Map();
    visibleRefs().forEach((ref, at) => {
      if (!index.has(ref)) index.set(ref, at);
    });
    return index;
  });
  const viewportHeight = () => Math.max(4, Math.floor((props.context.renderer.height || 32) * 0.5) - 4);
  const current = () => Math.min(selected(), Math.max(0, rows().length - 1));
  const reveal = index => {
    const id = `choreographer-row-${index}`;
    queueMicrotask(() => scrollRef?.scrollChildIntoView(id));
  };
  const revealPick = flat => {
    const id = `choreographer-pick-${flat}`;
    queueMicrotask(() => scrollRef?.scrollChildIntoView(id));
  };
  const move = delta => {
    const count = rows().length;
    if (count === 0) return;
    const next = Math.min(count - 1, Math.max(0, current() + delta));
    setSelected(next);
    reveal(next);
  };
  const pickerMove = delta => {
    const refs = visibleRefs();
    if (refs.length === 0) return;
    const next = Math.min(refs.length - 1, Math.max(0, pickerSel() + delta));
    setPickerSel(next);
    revealPick(next);
    const state = picker();
    if (state === null) return;
    if (next < 0 || next >= refs.length) return;
    const ref = refs[next];
    if (state.staged === ref) return;
    setPicker({
      ...state,
      ids: [...state.ids],
      staged: ref
    });
  };
  const applyQuery = (next, stage = true) => {
    if (suppressInput || next === query()) return;
    setQuery(next);
    const refs = visibleRefs();
    const state = picker();
    let staged = state?.staged ?? null;
    if (stage && state !== null && refs.length > 0 && (staged === null || !refs.includes(staged))) {
      staged = refs[0];
      setPicker({
        ...state,
        ids: [...state.ids],
        staged
      });
    }
    const at = staged === null ? 0 : refs.indexOf(staged);
    const sel = at < 0 ? 0 : at;
    setPickerSel(sel);
    revealPick(sel);
  };
  const adjustParallel = delta => {
    const effective = props.settings.maxParallel;
    const next = Math.min(PARALLEL_MAX, Math.max(PARALLEL_MIN, effective + delta));
    if (next !== effective) props.saveMaxParallel(next);
  };
  const adjust = delta => {
    const row = rows()[current()];
    if (row?.kind === "maxParallel") adjustParallel(delta);
  };
  const openPicker = (row, index) => {
    if (row.kind !== "primaryModel" && row.kind !== "fallbackModel" && row.kind !== "primaryBulk" && row.kind !== "fallbackBulk") return;
    const isPrimary = row.kind === "primaryModel" || row.kind === "primaryBulk";
    const isBulk = row.kind === "primaryBulk" || row.kind === "fallbackBulk";
    const ids = isBulk ? memberIdsFor(row.group) : [row.id];
    if (ids.length === 0) return;
    try {
      savedScrollTop = scrollRef?.scrollTop ?? 0;
    } catch {
      savedScrollTop = 0;
    }
    setQuery("");
    if (searchRef) {
      try {
        searchRef.value = "";
      } catch {
        // input remounts on open; the fresh value applies
      }
    }
    const startAt = staged => {
      if (staged === null) return 0;
      const found = visibleRefs().indexOf(staged);
      return found < 0 ? 0 : found;
    };
    const group = isBulk ? row.group : null;
    if (isPrimary) {
      if (!isBulk) {
        const single = ids[0];
        const staged = stagedRef(primaryEffective(single));
        const at = startAt(staged);
        setPickerSel(at);
        setPicker({
          mode: "primary",
          ids,
          group,
          origin: index,
          staged,
          opened: staged,
          custom: false
        });
        revealPick(at);
      } else {
        const effectives = ids.map(id => primaryEffective(id));
        const uniform = ids.length > 0 && effectives.every(value => value === effectives[0]);
        const shared = stagedRef(uniform ? effectives[0] : null);
        const at = startAt(shared);
        setPickerSel(at);
        setPicker({
          mode: "primary",
          ids,
          group,
          origin: index,
          staged: shared,
          opened: shared,
          custom: !uniform
        });
        revealPick(at);
      }
    } else {
      if (!isBulk) {
        const single = ids[0];
        const staged = stagedRef(props.modelSettings().fallback[single]?.[0] ?? null);
        const at = startAt(staged);
        setPickerSel(at);
        setPicker({
          mode: "fallback",
          ids,
          group,
          origin: index,
          staged,
          opened: staged,
          custom: false
        });
        revealPick(at);
      } else {
        const effectives = ids.map(id => fallbackEffective(id));
        const uniform = ids.length > 0 && effectives.every(list => listsEqual(list, effectives[0]));
        const shared = stagedRef(uniform ? effectives[0][0] : null);
        const at = startAt(shared);
        setPickerSel(at);
        setPicker({
          mode: "fallback",
          ids,
          group,
          origin: index,
          staged: shared,
          opened: shared,
          custom: !uniform
        });
        revealPick(at);
      }
    }
  };
  const focusRowForPicker = state => {
    if (state.group !== null) {
      const want = state.mode === "primary" ? "primaryBulk" : "fallbackBulk";
      const found = rows().findIndex(row => row.kind === want && row.group === state.group);
      if (found >= 0) return found;
    } else {
      const want = state.mode === "primary" ? "primaryModel" : "fallbackModel";
      const single = state.ids[0];
      const found = rows().findIndex(row => row.kind === want && row.id === single);
      if (found >= 0) return found;
    }
    return Math.min(state.origin, Math.max(0, rows().length - 1));
  };
  const restoreScroll = () => {
    const top = savedScrollTop;
    const node = scrollRef;
    setTimeout(() => {
      if (picker() !== null) return;
      const target = scrollRef ?? node;
      if (!target) return;
      try {
        target.scrollTop = top;
      } catch {
        // panel closed or renderer gone; leave the list where it is
      }
    }, 16);
  };
  const exitPicker = state => {
    setPicker(null);
    const next = focusRowForPicker(state);
    setSelected(next);
    reveal(next);
    restoreScroll();
  };
  const confirmPicker = () => {
    const state = picker();
    if (state === null) return;
    if (visibleRefs().length === 0) return;
    if (state.staged === state.opened) {
      exitPicker(state);
      return;
    }
    if (!props.online() || props.catalog().length === 0) return;
    if (state.mode === "primary") {
      const staged = state.staged;
      const ids = [...state.ids];
      void props.savePrimary(ids, staged).then(ok => {
        if (ok && picker() === state) exitPicker(state);
      });
    } else {
      const staged = state.staged;
      const ids = [...state.ids];
      void props.saveFallback(ids, staged === null ? null : [staged]).then(ok => {
        if (ok && picker() === state) exitPicker(state);
      });
    }
  };
  const clickEntry = flat => {
    const state = picker();
    if (state === null || !props.online() || props.catalog().length === 0) return;
    const refs = visibleRefs();
    if (flat < 0 || flat >= refs.length) return;
    const ref = refs[flat];
    setPickerSel(flat);
    setPicker({
      ...state,
      ids: [...state.ids],
      staged: ref
    });
    confirmPicker();
  };
  const pressConfirm = () => {
    if (picker() !== null) {
      confirmPicker();
      return;
    }
    const row = rows()[current()];
    if (row?.kind === "animation") props.toggleAnimation(row.key);else if (row?.kind === "ui") props.toggleUi(row.key);else if (row?.kind === "primaryModel" || row?.kind === "fallbackModel" || row?.kind === "primaryBulk" || row?.kind === "fallbackBulk") openPicker(row, current());
  };
  const pressSpace = () => {
    if (picker() !== null) return;
    const row = rows()[current()];
    if (row?.kind === "agent") {
      if (row.id === ORCHESTRATOR_ID) return;
      props.toggleAgent(row.id);
      return;
    }
    pressConfirm();
  };
  const pressClear = () => {
    const row = rows()[current()];
    if (row?.kind === "maxParallel") props.saveMaxParallel(PARALLEL_DEFAULT);else if (row?.kind === "primaryModel") void props.savePrimary([row.id], null);else if (row?.kind === "fallbackModel") void props.saveFallback([row.id], null);else if (row?.kind === "primaryBulk") {
      const ids = memberIdsFor(row.group);
      if (!ids.some(id => props.modelSettings().primary[id] !== undefined)) return;
      void props.savePrimary(ids, null);
    } else if (row?.kind === "fallbackBulk") {
      const ids = memberIdsFor(row.group);
      if (!ids.some(id => props.modelSettings().fallback[id] !== undefined)) return;
      void props.saveFallback(ids, null);
    }
  };
  const pressEscape = () => {
    const state = picker();
    if (state === null) {
      props.context.ui.dialog.clear();
      return;
    }
    if (query().length > 0) {
      applyQuery("", false);
      if (searchRef) {
        suppressInput = true;
        try {
          searchRef.value = "";
        } catch {
          // input stays mounted; the query reset drives the list
        } finally {
          suppressInput = false;
        }
      }
      return;
    }
    exitPicker(state);
  };
  props.context.keymap.layer(() => {
    if (picker() !== null) {
      return {
        mode: "global",
        priority: 10,
        commands: [{
          bind: "up",
          run: () => pickerMove(-1)
        }, {
          bind: "down",
          run: () => pickerMove(1)
        }, {
          bind: "return",
          run: () => pressConfirm()
        }, {
          bind: "escape",
          run: () => pressEscape()
        }]
      };
    }
    return {
      mode: "global",
      priority: 10,
      commands: [{
        bind: "up",
        run: () => move(-1)
      }, {
        bind: "down",
        run: () => move(1)
      }, {
        bind: "left",
        run: () => adjust(-1)
      }, {
        bind: "right",
        run: () => adjust(1)
      }, {
        bind: "return",
        run: () => pressConfirm()
      }, {
        bind: "space",
        run: () => pressSpace()
      }, {
        bind: "r",
        run: () => pressClear()
      }, {
        bind: "escape",
        run: () => pressEscape()
      }]
    };
  });
  const pickerTitle = () => {
    const state = picker();
    if (state === null) return "Choreographer settings";
    if (state.group !== null) {
      const count = state.ids.length;
      return state.mode === "primary" ? `primary model — ${state.group} (${count})` : `fallback model — ${state.group} (${count})`;
    }
    const single = state.ids[0] ?? "";
    return state.mode === "primary" ? `primary model — ${single}` : `fallback model — ${single}`;
  };
  const rowLine = (row, index) => {
    const active = () => index === current();
    const marker = () => active() ? "▸ " : "  ";
    const select = () => setSelected(index);
    const label = accent => (() => {
      var _el$ = _$createElement("box"),
        _el$2 = _$createElement("text");
      _$insertNode(_el$, _el$2);
      _$setProp(_el$, "flexDirection", "row");
      _$setProp(_el$, "flexShrink", 1);
      _$setProp(_el$, "minWidth", 0);
      _$setProp(_el$, "overflow", "hidden");
      _$setProp(_el$2, "wrapMode", "none");
      _$setProp(_el$2, "fg", accent);
      _$setProp(_el$2, "selectable", false);
      _$insert(_el$2, () => `${marker()}${row.label}`);
      _$effect(_$p => _$setProp(_el$2, "attributes", active() ? TextAttributes.BOLD : undefined, _$p));
      return _el$;
    })();
    if (row.kind === "animation" || row.kind === "ui") {
      const accent = row.kind === "animation" ? FLOW[0] : FLOW[1];
      const on = () => row.kind === "animation" ? props.settings.animations[row.key] : props.settings.ui?.[row.key] ?? true;
      const toggleRow = () => {
        if (row.kind === "animation") props.toggleAnimation(row.key);else props.toggleUi(row.key);
      };
      return (() => {
        var _el$3 = _$createElement("box"),
          _el$4 = _$createElement("text");
        _$insertNode(_el$3, _el$4);
        _$setProp(_el$3, "flexDirection", "row");
        _$setProp(_el$3, "width", "100%");
        _$setProp(_el$3, "justifyContent", "space-between");
        _$setProp(_el$3, "columnGap", 2);
        _$setProp(_el$3, "onMouseDown", event => {
          if (event.button !== 0 || event.isDragging) return;
          select();
          toggleRow();
        });
        _$insert(_el$3, () => label(accent), _el$4);
        _$setProp(_el$4, "selectable", false);
        _$insert(_el$4, () => on() ? "on" : "off");
        _$effect(_p$ => {
          var _v$ = on() ? "#a6e3a1" : "#f5a97f",
            _v$2 = active() ? TextAttributes.BOLD : undefined;
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$4, "fg", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$4, "attributes", _v$2, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$3;
      })();
    }
    if (row.kind === "maxParallel") {
      const accent = FLOW[1];
      const effective = () => props.settings.maxParallel;
      const changed = () => props.settings.maxParallel !== PARALLEL_DEFAULT;
      const atMin = () => effective() <= PARALLEL_MIN;
      const atMax = () => effective() >= PARALLEL_MAX;
      const nudge = delta => event => {
        if (event.button !== 0 || event.isDragging) return;
        event.stopPropagation();
        select();
        adjustParallel(delta);
      };
      return (() => {
        var _el$5 = _$createElement("box"),
          _el$6 = _$createElement("box"),
          _el$8 = _$createElement("box"),
          _el$9 = _$createElement("text"),
          _el$1 = _$createElement("text"),
          _el$10 = _$createElement("box"),
          _el$11 = _$createElement("text");
        _$insertNode(_el$5, _el$6);
        _$setProp(_el$5, "flexDirection", "row");
        _$setProp(_el$5, "width", "100%");
        _$setProp(_el$5, "justifyContent", "space-between");
        _$setProp(_el$5, "columnGap", 2);
        _$setProp(_el$5, "onMouseDown", event => {
          if (event.button !== 0 || event.isDragging) return;
          select();
        });
        _$insert(_el$5, () => label(accent), _el$6);
        _$insertNode(_el$6, _el$8);
        _$insertNode(_el$6, _el$1);
        _$insertNode(_el$6, _el$10);
        _$setProp(_el$6, "flexDirection", "row");
        _$setProp(_el$6, "columnGap", 1);
        _$setProp(_el$6, "flexShrink", 0);
        _$insert(_el$6, _$createComponent(Show, {
          get when() {
            return changed();
          },
          get children() {
            var _el$7 = _$createElement("text");
            _$setProp(_el$7, "selectable", false);
            _$insert(_el$7, `default ${PARALLEL_DEFAULT}`);
            _$effect(_$p => _$setProp(_el$7, "fg", props.context.theme.text.faint, _$p));
            return _el$7;
          }
        }), _el$8);
        _$insertNode(_el$8, _el$9);
        _$insertNode(_el$9, _$createTextNode(`−`));
        _$setProp(_el$9, "selectable", false);
        _$setProp(_el$1, "fg", accent);
        _$setProp(_el$1, "selectable", false);
        _$insert(_el$1, () => `${effective()}`);
        _$insertNode(_el$10, _el$11);
        _$insertNode(_el$11, _$createTextNode(`+`));
        _$setProp(_el$11, "selectable", false);
        _$effect(_p$ => {
          var _v$3 = nudge(-1),
            _v$4 = atMin() ? props.context.theme.text.faint : accent,
            _v$5 = active() || changed() ? TextAttributes.BOLD : undefined,
            _v$6 = nudge(1),
            _v$7 = atMax() ? props.context.theme.text.faint : accent;
          _v$3 !== _p$.e && (_p$.e = _$setProp(_el$8, "onMouseDown", _v$3, _p$.e));
          _v$4 !== _p$.t && (_p$.t = _$setProp(_el$9, "fg", _v$4, _p$.t));
          _v$5 !== _p$.a && (_p$.a = _$setProp(_el$1, "attributes", _v$5, _p$.a));
          _v$6 !== _p$.o && (_p$.o = _$setProp(_el$10, "onMouseDown", _v$6, _p$.o));
          _v$7 !== _p$.i && (_p$.i = _$setProp(_el$11, "fg", _v$7, _p$.i));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined
        });
        return _el$5;
      })();
    }
    if (row.kind === "agent") {
      const isOrchestrator = row.id === ORCHESTRATOR_ID;
      const off = () => !isOrchestrator && props.disabled().includes(row.id);
      const accent = agentColor(props.agentById(row.id), row.id);
      const idColor = () => off() ? props.context.theme.text.faint : accent;
      const toggleBox = event => {
        if (event.button !== 0 || event.isDragging) return;
        event.stopPropagation();
        select();
        props.toggleAgent(row.id);
      };
      return (() => {
        var _el$13 = _$createElement("box"),
          _el$14 = _$createElement("box"),
          _el$15 = _$createElement("text"),
          _el$18 = _$createElement("text");
        _$insertNode(_el$13, _el$14);
        _$setProp(_el$13, "flexDirection", "row");
        _$setProp(_el$13, "width", "100%");
        _$setProp(_el$13, "justifyContent", "space-between");
        _$setProp(_el$13, "columnGap", 2);
        _$setProp(_el$13, "onMouseDown", event => {
          if (event.button !== 0 || event.isDragging) return;
          select();
        });
        _$insertNode(_el$14, _el$15);
        _$insertNode(_el$14, _el$18);
        _$setProp(_el$14, "flexDirection", "row");
        _$setProp(_el$14, "flexShrink", 1);
        _$setProp(_el$14, "minWidth", 0);
        _$setProp(_el$14, "overflow", "hidden");
        _$setProp(_el$14, "columnGap", 1);
        _$setProp(_el$15, "selectable", false);
        _$insert(_el$15, marker);
        _$insert(_el$14, _$createComponent(Show, {
          when: !isOrchestrator,
          get children() {
            var _el$16 = _$createElement("box"),
              _el$17 = _$createElement("text");
            _$insertNode(_el$16, _el$17);
            _$setProp(_el$16, "onMouseDown", toggleBox);
            _$setProp(_el$17, "selectable", false);
            _$insert(_el$17, () => off() ? "[ ]" : "[x]");
            _$effect(_p$ => {
              var _v$8 = off() ? props.context.theme.text.faint : "#a6e3a1",
                _v$9 = active() ? TextAttributes.BOLD : undefined;
              _v$8 !== _p$.e && (_p$.e = _$setProp(_el$17, "fg", _v$8, _p$.e));
              _v$9 !== _p$.t && (_p$.t = _$setProp(_el$17, "attributes", _v$9, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$16;
          }
        }), _el$18);
        _$setProp(_el$18, "wrapMode", "none");
        _$setProp(_el$18, "selectable", false);
        _$insert(_el$18, () => row.label);
        _$insert(_el$14, _$createComponent(Show, {
          get when() {
            return off();
          },
          get children() {
            var _el$19 = _$createElement("text");
            _$insertNode(_el$19, _$createTextNode(`off`));
            _$setProp(_el$19, "fg", "#f5a97f");
            _$setProp(_el$19, "selectable", false);
            return _el$19;
          }
        }), null);
        _$effect(_p$ => {
          var _v$0 = props.context.theme.text.base,
            _v$1 = active() ? TextAttributes.BOLD : undefined,
            _v$10 = idColor(),
            _v$11 = active() ? TextAttributes.BOLD : undefined;
          _v$0 !== _p$.e && (_p$.e = _$setProp(_el$15, "fg", _v$0, _p$.e));
          _v$1 !== _p$.t && (_p$.t = _$setProp(_el$15, "attributes", _v$1, _p$.t));
          _v$10 !== _p$.a && (_p$.a = _$setProp(_el$18, "fg", _v$10, _p$.a));
          _v$11 !== _p$.o && (_p$.o = _$setProp(_el$18, "attributes", _v$11, _p$.o));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined
        });
        return _el$13;
      })();
    }
    if (row.kind === "primaryBulk") {
      const accent = SECTIONS[row.kind].color;
      const open = () => openPicker(row, index);
      const ids = () => memberIdsFor(row.group);
      const valueText = () => primaryBulkValue(ids());
      return (() => {
        var _el$21 = _$createElement("box"),
          _el$22 = _$createElement("text");
        _$insertNode(_el$21, _el$22);
        _$setProp(_el$21, "flexDirection", "row");
        _$setProp(_el$21, "width", "100%");
        _$setProp(_el$21, "justifyContent", "space-between");
        _$setProp(_el$21, "columnGap", 2);
        _$setProp(_el$21, "onMouseDown", event => {
          if (event.button !== 0 || event.isDragging) return;
          select();
          open();
        });
        _$insert(_el$21, () => label(accent), _el$22);
        _$setProp(_el$22, "fg", accent);
        _$setProp(_el$22, "selectable", false);
        _$insert(_el$22, valueText);
        _$effect(_$p => _$setProp(_el$22, "attributes", active() ? TextAttributes.BOLD : undefined, _$p));
        return _el$21;
      })();
    }
    if (row.kind === "fallbackBulk") {
      const accent = SECTIONS[row.kind].color;
      const open = () => openPicker(row, index);
      const ids = () => memberIdsFor(row.group);
      const valueText = () => fallbackBulkValue(ids());
      return (() => {
        var _el$23 = _$createElement("box"),
          _el$24 = _$createElement("text");
        _$insertNode(_el$23, _el$24);
        _$setProp(_el$23, "flexDirection", "row");
        _$setProp(_el$23, "width", "100%");
        _$setProp(_el$23, "justifyContent", "space-between");
        _$setProp(_el$23, "columnGap", 2);
        _$setProp(_el$23, "onMouseDown", event => {
          if (event.button !== 0 || event.isDragging) return;
          select();
          open();
        });
        _$insert(_el$23, () => label(accent), _el$24);
        _$setProp(_el$24, "fg", accent);
        _$setProp(_el$24, "selectable", false);
        _$insert(_el$24, valueText);
        _$effect(_$p => _$setProp(_el$24, "attributes", active() ? TextAttributes.BOLD : undefined, _$p));
        return _el$23;
      })();
    }
    const accent = agentColor(props.agentById(row.id), row.id);
    const open = () => openPicker(row, index);
    if (row.kind === "primaryModel") {
      const valueText = () => {
        const shown = primaryEffective(row.id);
        if (shown === null) return "inherit";
        return truncateMiddle(nameForRef(shown), 26);
      };
      return (() => {
        var _el$25 = _$createElement("box"),
          _el$26 = _$createElement("text");
        _$insertNode(_el$25, _el$26);
        _$setProp(_el$25, "flexDirection", "row");
        _$setProp(_el$25, "width", "100%");
        _$setProp(_el$25, "justifyContent", "space-between");
        _$setProp(_el$25, "columnGap", 2);
        _$setProp(_el$25, "onMouseDown", event => {
          if (event.button !== 0 || event.isDragging) return;
          select();
          open();
        });
        _$insert(_el$25, () => label(accent), _el$26);
        _$setProp(_el$26, "fg", accent);
        _$setProp(_el$26, "selectable", false);
        _$insert(_el$26, valueText);
        _$effect(_$p => _$setProp(_el$26, "attributes", active() ? TextAttributes.BOLD : undefined, _$p));
        return _el$25;
      })();
    }
    const valueText = () => listText(fallbackEffective(row.id));
    return (() => {
      var _el$27 = _$createElement("box"),
        _el$28 = _$createElement("text");
      _$insertNode(_el$27, _el$28);
      _$setProp(_el$27, "flexDirection", "row");
      _$setProp(_el$27, "width", "100%");
      _$setProp(_el$27, "justifyContent", "space-between");
      _$setProp(_el$27, "columnGap", 2);
      _$setProp(_el$27, "onMouseDown", event => {
        if (event.button !== 0 || event.isDragging) return;
        select();
        open();
      });
      _$insert(_el$27, () => label(accent), _el$28);
      _$setProp(_el$28, "fg", accent);
      _$setProp(_el$28, "selectable", false);
      _$insert(_el$28, valueText);
      _$effect(_$p => _$setProp(_el$28, "attributes", active() ? TextAttributes.BOLD : undefined, _$p));
      return _el$27;
    })();
  };
  const section = (title, colour) => (() => {
    var _el$29 = _$createElement("box"),
      _el$30 = _$createElement("text");
    _$insertNode(_el$29, _el$30);
    _$setProp(_el$29, "marginTop", 1);
    _$setProp(_el$30, "fg", colour);
    _$setProp(_el$30, "selectable", false);
    _$insert(_el$30, title);
    _$effect(_$p => _$setProp(_el$30, "attributes", TextAttributes.BOLD, _$p));
    return _el$29;
  })();
  const subheader = title => (() => {
    var _el$31 = _$createElement("box"),
      _el$32 = _$createElement("text");
    _$insertNode(_el$31, _el$32);
    _$setProp(_el$31, "marginTop", 1);
    _$setProp(_el$32, "selectable", false);
    _$insert(_el$32, title);
    _$effect(_p$ => {
      var _v$12 = props.context.theme.text.faint,
        _v$13 = TextAttributes.BOLD;
      _v$12 !== _p$.e && (_p$.e = _$setProp(_el$32, "fg", _v$12, _p$.e));
      _v$13 !== _p$.t && (_p$.t = _$setProp(_el$32, "attributes", _v$13, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$31;
  })();
  return (() => {
    var _el$33 = _$createElement("box"),
      _el$34 = _$createElement("box"),
      _el$35 = _$createElement("text"),
      _el$36 = _$createElement("box"),
      _el$37 = _$createElement("text"),
      _el$39 = _$createElement("box"),
      _el$40 = _$createElement("text"),
      _el$44 = _$createElement("scrollbox"),
      _el$45 = _$createElement("box"),
      _el$46 = _$createElement("text"),
      _el$52 = _$createElement("text");
    _$insertNode(_el$33, _el$34);
    _$insertNode(_el$33, _el$39);
    _$insertNode(_el$33, _el$44);
    _$insertNode(_el$33, _el$45);
    _$insertNode(_el$33, _el$52);
    _$setProp(_el$33, "flexDirection", "column");
    _$setProp(_el$33, "width", "100%");
    _$setProp(_el$33, "paddingX", 2);
    _$setProp(_el$33, "paddingY", 1);
    _$insertNode(_el$34, _el$35);
    _$insertNode(_el$34, _el$36);
    _$setProp(_el$34, "flexDirection", "row");
    _$setProp(_el$34, "width", "100%");
    _$setProp(_el$34, "justifyContent", "space-between");
    _$setProp(_el$34, "alignItems", "center");
    _$setProp(_el$35, "selectable", false);
    _$insert(_el$35, pickerTitle);
    _$insertNode(_el$36, _el$37);
    _$setProp(_el$36, "height", 1);
    _$setProp(_el$36, "onMouseDown", event => {
      if (event.button === 0) props.context.ui.dialog.clear();
    });
    _$insertNode(_el$37, _$createTextNode(`[esc]`));
    _$setProp(_el$37, "selectable", false);
    _$insertNode(_el$39, _el$40);
    _$setProp(_el$39, "width", "100%");
    _$setProp(_el$39, "overflow", "hidden");
    _$insertNode(_el$40, _$createTextNode(`────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`));
    _$setProp(_el$40, "wrapMode", "none");
    _$setProp(_el$40, "selectable", false);
    _$insert(_el$33, _$createComponent(Show, {
      get when() {
        return picker() !== null;
      },
      get children() {
        var _el$42 = _$createElement("box"),
          _el$43 = _$createElement("input");
        _$insertNode(_el$42, _el$43);
        _$setProp(_el$42, "width", "100%");
        _$setProp(_el$42, "marginTop", 1);
        _$use(node => searchRef = node ?? undefined, _el$43);
        _$setProp(_el$43, "width", "100%");
        _$setProp(_el$43, "value", "");
        _$setProp(_el$43, "placeholder", "type to filter models…");
        _$setProp(_el$43, "onInput", value => applyQuery(value));
        _$effect(_$p => _$setProp(_el$43, "focused", picker() !== null, _$p));
        return _el$42;
      }
    }), _el$44);
    _$use(node => scrollRef = node ?? undefined, _el$44);
    _$setProp(_el$44, "width", "100%");
    _$setProp(_el$44, "scrollY", true);
    _$setProp(_el$44, "scrollX", false);
    _$setProp(_el$44, "stickyScroll", false);
    _$setProp(_el$44, "paddingRight", 1);
    _$insert(_el$44, _$createComponent(Show, {
      get when() {
        return picker() === null;
      },
      get fallback() {
        return (() => {
          var _el$55 = _$createElement("box");
          _$setProp(_el$55, "flexDirection", "column");
          _$setProp(_el$55, "width", "100%");
          _$insert(_el$55, _$createComponent(Show, {
            get when() {
              return flatRefs().length === 0;
            },
            get children() {
              var _el$56 = _$createElement("box"),
                _el$57 = _$createElement("text");
              _$insertNode(_el$56, _el$57);
              _$setProp(_el$56, "marginTop", 1);
              _$insertNode(_el$57, _$createTextNode(`no models available`));
              _$setProp(_el$57, "selectable", false);
              _$effect(_$p => _$setProp(_el$57, "fg", props.context.theme.text.faint, _$p));
              return _el$56;
            }
          }), null);
          _$insert(_el$55, _$createComponent(Show, {
            get when() {
              return _$memo(() => flatRefs().length > 0)() && visibleRefs().length === 0;
            },
            get children() {
              var _el$59 = _$createElement("box"),
                _el$60 = _$createElement("text");
              _$insertNode(_el$59, _el$60);
              _$setProp(_el$59, "marginTop", 1);
              _$setProp(_el$60, "selectable", false);
              _$insert(_el$60, () => `no matches for "${truncate(query(), 28)}"`);
              _$effect(_$p => _$setProp(_el$60, "fg", props.context.theme.text.faint, _$p));
              return _el$59;
            }
          }), null);
          _$insert(_el$55, _$createComponent(For, {
            get each() {
              return filteredGroups();
            },
            children: group => (() => {
              var _el$61 = _$createElement("box"),
                _el$62 = _$createElement("box"),
                _el$63 = _$createElement("text");
              _$insertNode(_el$61, _el$62);
              _$setProp(_el$61, "flexDirection", "column");
              _$setProp(_el$61, "width", "100%");
              _$insertNode(_el$62, _el$63);
              _$setProp(_el$62, "marginTop", 1);
              _$setProp(_el$63, "selectable", false);
              _$insert(_el$63, () => group.provider);
              _$insert(_el$61, _$createComponent(For, {
                get each() {
                  return group.items;
                },
                children: item => {
                  const ref = `${item.providerID}/${item.id}`;
                  const flat = visibleIndex().get(ref) ?? -1;
                  const entryLabel = item?.name?.trim() || ref;
                  const focused = () => flat === pickerSel();
                  const isStaged = () => picker()?.staged === ref;
                  return (() => {
                    var _el$64 = _$createElement("box"),
                      _el$65 = _$createElement("text"),
                      _el$66 = _$createElement("text");
                    _$insertNode(_el$64, _el$65);
                    _$insertNode(_el$64, _el$66);
                    _$setProp(_el$64, "id", `choreographer-pick-${flat}`);
                    _$setProp(_el$64, "flexDirection", "row");
                    _$setProp(_el$64, "width", "100%");
                    _$setProp(_el$64, "columnGap", 1);
                    _$setProp(_el$64, "onMouseDown", event => {
                      if (event.button !== 0 || event.isDragging) return;
                      clickEntry(flat);
                    });
                    _$setProp(_el$65, "selectable", false);
                    _$insert(_el$65, () => focused() ? "▸ " : "  ");
                    _$setProp(_el$66, "selectable", false);
                    _$insert(_el$66, () => truncateMiddle(entryLabel, 30));
                    _$effect(_p$ => {
                      var _v$25 = focused() ? "#c6a0f6" : props.context.theme.text.muted,
                        _v$26 = focused() ? TextAttributes.BOLD : undefined,
                        _v$27 = isStaged() ? "#a6e3a1" : props.context.theme.text.base,
                        _v$28 = focused() || isStaged() ? TextAttributes.BOLD : undefined;
                      _v$25 !== _p$.e && (_p$.e = _$setProp(_el$65, "fg", _v$25, _p$.e));
                      _v$26 !== _p$.t && (_p$.t = _$setProp(_el$65, "attributes", _v$26, _p$.t));
                      _v$27 !== _p$.a && (_p$.a = _$setProp(_el$66, "fg", _v$27, _p$.a));
                      _v$28 !== _p$.o && (_p$.o = _$setProp(_el$66, "attributes", _v$28, _p$.o));
                      return _p$;
                    }, {
                      e: undefined,
                      t: undefined,
                      a: undefined,
                      o: undefined
                    });
                    return _el$64;
                  })();
                }
              }), null);
              _$effect(_p$ => {
                var _v$23 = props.context.theme.text.faint,
                  _v$24 = TextAttributes.BOLD;
                _v$23 !== _p$.e && (_p$.e = _$setProp(_el$63, "fg", _v$23, _p$.e));
                _v$24 !== _p$.t && (_p$.t = _$setProp(_el$63, "attributes", _v$24, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$61;
            })()
          }), null);
          return _el$55;
        })();
      },
      get children() {
        return _$createComponent(For, {
          get each() {
            return rows();
          },
          children: (row, index) => (() => {
            var _el$67 = _$createElement("box");
            _$setProp(_el$67, "flexDirection", "column");
            _$setProp(_el$67, "width", "100%");
            _$insert(_el$67, _$createComponent(Show, {
              get when() {
                return sectionOf(rows()[index() - 1]) !== sectionOf(row);
              },
              get children() {
                return section(SECTIONS[row.kind].title, SECTIONS[row.kind].color);
              }
            }), null);
            _$insert(_el$67, _$createComponent(Show, {
              get when() {
                return _$memo(() => !!(row.kind === "agent" && (index() === 0 || rows()[index() - 1]?.kind !== "agent")))() && SUBAGENT_IDS.every(id => props.disabled().includes(id));
              },
              get children() {
                var _el$68 = _$createElement("box"),
                  _el$69 = _$createElement("text");
                _$insertNode(_el$68, _el$69);
                _$insertNode(_el$69, _$createTextNode(`all subagents off — orchestrator runs alone`));
                _$setProp(_el$69, "selectable", false);
                _$effect(_$p => _$setProp(_el$69, "fg", props.context.theme.text.faint, _$p));
                return _el$68;
              }
            }), null);
            _$insert(_el$67, _$createComponent(Show, {
              get when() {
                return _$memo(() => groupOf(row) !== null)() && groupOf(rows()[index() - 1]) !== groupOf(row);
              },
              get children() {
                return subheader(groupLabelFor(groupOf(row)));
              }
            }), null);
            _$insert(_el$67, () => rowLine(row, index()), null);
            _$effect(_$p => _$setProp(_el$67, "id", `choreographer-row-${index()}`, _$p));
            return _el$67;
          })()
        });
      }
    }));
    _$insertNode(_el$45, _el$46);
    _$setProp(_el$45, "marginTop", 1);
    _$setProp(_el$45, "width", "100%");
    _$setProp(_el$45, "overflow", "hidden");
    _$insertNode(_el$46, _$createTextNode(`────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`));
    _$setProp(_el$46, "wrapMode", "none");
    _$setProp(_el$46, "selectable", false);
    _$insert(_el$33, _$createComponent(Show, {
      get when() {
        return picker() === null;
      },
      get fallback() {
        return (() => {
          var _el$71 = _$createElement("box"),
            _el$72 = _$createElement("text"),
            _el$74 = _$createElement("text");
          _$insertNode(_el$71, _el$72);
          _$insertNode(_el$71, _el$74);
          _$setProp(_el$71, "flexDirection", "column");
          _$setProp(_el$71, "width", "100%");
          _$insertNode(_el$72, _$createTextNode(`↑↓ move · enter confirm · esc clear / back`));
          _$setProp(_el$72, "wrapMode", "none");
          _$setProp(_el$72, "selectable", false);
          _$insertNode(_el$74, _$createTextNode(`click confirms · wheel scrolls · type filters`));
          _$setProp(_el$74, "wrapMode", "none");
          _$setProp(_el$74, "selectable", false);
          _$insert(_el$71, _$createComponent(Show, {
            get when() {
              return (picker()?.ids.length ?? 0) > 1;
            },
            get children() {
              var _el$76 = _$createElement("text");
              _$setProp(_el$76, "wrapMode", "none");
              _$setProp(_el$76, "selectable", false);
              _$insert(_el$76, () => `enter applies to all ${picker()?.ids.length} in group`);
              _$effect(_$p => _$setProp(_el$76, "fg", props.context.theme.text.faint, _$p));
              return _el$76;
            }
          }), null);
          _$effect(_p$ => {
            var _v$29 = props.context.theme.text.faint,
              _v$30 = props.context.theme.text.faint;
            _v$29 !== _p$.e && (_p$.e = _$setProp(_el$72, "fg", _v$29, _p$.e));
            _v$30 !== _p$.t && (_p$.t = _$setProp(_el$74, "fg", _v$30, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$71;
        })();
      },
      get children() {
        return [(() => {
          var _el$48 = _$createElement("text");
          _$insertNode(_el$48, _$createTextNode(`↑↓ move · ←→ adjust · enter pick · space on/off · r reset · esc close`));
          _$setProp(_el$48, "wrapMode", "none");
          _$setProp(_el$48, "selectable", false);
          _$effect(_$p => _$setProp(_el$48, "fg", props.context.theme.text.faint, _$p));
          return _el$48;
        })(), (() => {
          var _el$50 = _$createElement("text");
          _$insertNode(_el$50, _$createTextNode(`click checkbox toggles`));
          _$setProp(_el$50, "wrapMode", "none");
          _$setProp(_el$50, "selectable", false);
          _$effect(_$p => _$setProp(_el$50, "fg", props.context.theme.text.faint, _$p));
          return _el$50;
        })()];
      }
    }), _el$52);
    _$setProp(_el$52, "selectable", false);
    _$insert(_el$52, () => props.online() ? "plugin connected" : "plugin unreachable: local only");
    _$insert(_el$33, _$createComponent(Show, {
      get when() {
        return _$memo(() => picker() !== null)() && !props.online();
      },
      get children() {
        var _el$53 = _$createElement("text");
        _$insertNode(_el$53, _$createTextNode(`read-only while offline`));
        _$setProp(_el$53, "selectable", false);
        _$effect(_$p => _$setProp(_el$53, "fg", props.context.theme.text.faint, _$p));
        return _el$53;
      }
    }), null);
    _$effect(_p$ => {
      var _v$14 = props.context.theme.text.base,
        _v$15 = TextAttributes.BOLD,
        _v$16 = props.context.theme.text.muted,
        _v$17 = TextAttributes.BOLD,
        _v$18 = props.context.theme.text.faint,
        _v$19 = Math.min(picker() === null ? rows().length + 6 : groups().length + flatRefs().length + 3, viewportHeight()),
        _v$20 = picker() === null ? 0 : 1,
        _v$21 = props.context.theme.text.faint,
        _v$22 = props.online() ? "#a6e3a1" : "#f5a97f";
      _v$14 !== _p$.e && (_p$.e = _$setProp(_el$35, "fg", _v$14, _p$.e));
      _v$15 !== _p$.t && (_p$.t = _$setProp(_el$35, "attributes", _v$15, _p$.t));
      _v$16 !== _p$.a && (_p$.a = _$setProp(_el$37, "fg", _v$16, _p$.a));
      _v$17 !== _p$.o && (_p$.o = _$setProp(_el$37, "attributes", _v$17, _p$.o));
      _v$18 !== _p$.i && (_p$.i = _$setProp(_el$40, "fg", _v$18, _p$.i));
      _v$19 !== _p$.n && (_p$.n = _$setProp(_el$44, "height", _v$19, _p$.n));
      _v$20 !== _p$.s && (_p$.s = _$setProp(_el$44, "marginTop", _v$20, _p$.s));
      _v$21 !== _p$.h && (_p$.h = _$setProp(_el$46, "fg", _v$21, _p$.h));
      _v$22 !== _p$.r && (_p$.r = _$setProp(_el$52, "fg", _v$22, _p$.r));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined
    });
    return _el$33;
  })();
}
