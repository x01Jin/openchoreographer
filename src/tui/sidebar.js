import { createComponent as _$createComponent } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { For, Show, createSignal } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { MODEL_WIDTH, NAME_WIDTH, TODO_LIMIT, agentColor, hueHex, modelName, truncate } from "./format";
import { displayWidth } from "../shared/text";
import { FlowingLabel } from "./flowing-label.js";
const FALLBACK_FG = "#f5a97f";
const padStartCells = (value, width) => {
  let used = 0;
  for (const char of value) used += displayWidth(char);
  return used >= width ? value : `${" ".repeat(width - used)}${value}`;
};
export function Sidebar(props) {
  const sessionID = props.sessionID;
  const header = (section, title, count, small = false) => (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "focusable", true);
    _$setProp(_el$, "onMouseDown", event => {
      if (event.button !== 0 || event.isDragging) return;
      props.toggle(section);
    });
    _$setProp(_el$, "onKeyDown", event => {
      if (event.name === "return" || event.name === "space") props.toggle(section);
    });
    _$setProp(_el$2, "selectable", false);
    _$insert(_el$2, () => `${props.isOpen(section) ? small ? "▾" : "▼" : small ? "▸" : "▶"} ${title}${props.isOpen(section) ? "" : ` (${count()})`}`);
    _$effect(_p$ => {
      var _v$ = props.context.theme.text.base,
        _v$2 = TextAttributes.BOLD;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$2, "attributes", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
  const row = agent => {
    const active = () => {
      props.dataVersion();
      return props.context.data.session.get(sessionID)?.agent === agent.id;
    };
    const isFallback = () => props.fallbackModel(agent);
    const pending = () => props.switchPending(agent);
    const busy = () => props.switchBusy(agent);
    const confirming = () => isFallback() && pending() && !busy();
    const modelText = () => {
      if (!isFallback()) return truncate(props.activeModel(agent), MODEL_WIDTH);
      if (confirming()) return "switch primary?";
      return padStartCells(`↳ ${truncate(props.activeModel(agent), MODEL_WIDTH - 2)}`, MODEL_WIDTH);
    };
    const modelFg = () => {
      if (confirming()) return props.context.theme.text.base;
      if (isFallback()) return FALLBACK_FG;
      return active() ? props.context.theme.text.muted : props.context.theme.text.faint;
    };
    return (() => {
      var _el$3 = _$createElement("box"),
        _el$4 = _$createElement("box"),
        _el$5 = _$createElement("text"),
        _el$6 = _$createElement("text"),
        _el$7 = _$createElement("box"),
        _el$8 = _$createElement("text");
      _$insertNode(_el$3, _el$4);
      _$insertNode(_el$3, _el$7);
      _$setProp(_el$3, "flexDirection", "row");
      _$setProp(_el$3, "width", "100%");
      _$setProp(_el$3, "justifyContent", "space-between");
      _$setProp(_el$3, "columnGap", 1);
      _$insertNode(_el$4, _el$5);
      _$insertNode(_el$4, _el$6);
      _$setProp(_el$4, "flexDirection", "row");
      _$setProp(_el$4, "flexShrink", 1);
      _$setProp(_el$4, "minWidth", 0);
      _$setProp(_el$4, "overflow", "hidden");
      _$setProp(_el$5, "wrapMode", "none");
      _$setProp(_el$5, "flexShrink", 0);
      _$setProp(_el$5, "selectable", false);
      _$insert(_el$5, () => active() ? "● " : "  ");
      _$setProp(_el$6, "wrapMode", "none");
      _$setProp(_el$6, "selectable", false);
      _$insert(_el$6, () => truncate(agent.name, NAME_WIDTH));
      _$insertNode(_el$7, _el$8);
      _$setProp(_el$7, "flexShrink", 0);
      _$setProp(_el$8, "wrapMode", "none");
      _$setProp(_el$8, "selectable", false);
      _$insert(_el$8, modelText);
      _$effect(_p$ => {
        var _v$3 = active() ? props.context.theme.text.base : props.context.theme.text.faint,
          _v$4 = agentColor(agent, agent.id),
          _v$5 = isFallback() && !busy() ? event => {
            if (event.button !== 0 || event.isDragging) return;
            event.stopPropagation();
            props.requestSwitch(agent.id);
          } : undefined,
          _v$6 = modelFg(),
          _v$7 = confirming() ? TextAttributes.BOLD : undefined;
        _v$3 !== _p$.e && (_p$.e = _$setProp(_el$5, "fg", _v$3, _p$.e));
        _v$4 !== _p$.t && (_p$.t = _$setProp(_el$6, "fg", _v$4, _p$.t));
        _v$5 !== _p$.a && (_p$.a = _$setProp(_el$7, "onMouseDown", _v$5, _p$.a));
        _v$6 !== _p$.o && (_p$.o = _$setProp(_el$8, "fg", _v$6, _p$.o));
        _v$7 !== _p$.i && (_p$.i = _$setProp(_el$8, "attributes", _v$7, _p$.i));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined,
        i: undefined
      });
      return _el$3;
    })();
  };
  const runningRow = session => {
    const agent = () => (props.agentList() ?? []).find(candidate => candidate.id === session.agent);
    const model = () => {
      const found = agent();
      return session.model ? modelName(session.model, props.modelIndex()) : found?.model ? modelName(found.model, props.modelIndex()) : "inherit";
    };
    const [hovered, setHovered] = createSignal(false);
    return (() => {
      var _el$9 = _$createElement("box"),
        _el$0 = _$createElement("box"),
        _el$1 = _$createElement("text"),
        _el$11 = _$createElement("text"),
        _el$12 = _$createElement("text"),
        _el$14 = _$createElement("box"),
        _el$15 = _$createElement("text");
      _$insertNode(_el$9, _el$0);
      _$insertNode(_el$9, _el$14);
      _$setProp(_el$9, "flexDirection", "row");
      _$setProp(_el$9, "width", "100%");
      _$setProp(_el$9, "justifyContent", "space-between");
      _$setProp(_el$9, "columnGap", 1);
      _$setProp(_el$9, "onMouseOver", () => setHovered(true));
      _$setProp(_el$9, "onMouseOut", () => setHovered(false));
      _$setProp(_el$9, "onMouseDown", event => {
        if (event.button !== 0 || event.isDragging) return;
        event.stopPropagation();
        props.context.ui.router.navigate({
          type: "session",
          sessionID: session.id
        });
      });
      _$insertNode(_el$0, _el$1);
      _$insertNode(_el$0, _el$11);
      _$insertNode(_el$0, _el$12);
      _$setProp(_el$0, "flexDirection", "row");
      _$setProp(_el$0, "flexShrink", 1);
      _$setProp(_el$0, "minWidth", 0);
      _$setProp(_el$0, "overflow", "hidden");
      _$insertNode(_el$1, _$createTextNode(`  `));
      _$setProp(_el$1, "wrapMode", "none");
      _$setProp(_el$1, "flexShrink", 0);
      _$setProp(_el$1, "selectable", false);
      _$setProp(_el$11, "wrapMode", "none");
      _$setProp(_el$11, "selectable", false);
      _$insert(_el$11, () => truncate(agent()?.name ?? session.agent ?? "unknown", NAME_WIDTH));
      _$insertNode(_el$12, _$createTextNode(` ↗`));
      _$setProp(_el$12, "wrapMode", "none");
      _$setProp(_el$12, "flexShrink", 0);
      _$setProp(_el$12, "selectable", false);
      _$insertNode(_el$14, _el$15);
      _$setProp(_el$14, "flexShrink", 0);
      _$setProp(_el$15, "wrapMode", "none");
      _$setProp(_el$15, "selectable", false);
      _$insert(_el$15, () => truncate(model(), MODEL_WIDTH));
      _$effect(_p$ => {
        var _v$8 = props.context.theme.text.faint,
          _v$9 = agentColor(agent(), session.agent),
          _v$0 = hovered() ? TextAttributes.BOLD : undefined,
          _v$1 = hovered() ? props.context.theme.text.base : props.context.theme.text.faint,
          _v$10 = hovered() ? props.context.theme.text.base : props.context.theme.text.muted;
        _v$8 !== _p$.e && (_p$.e = _$setProp(_el$1, "fg", _v$8, _p$.e));
        _v$9 !== _p$.t && (_p$.t = _$setProp(_el$11, "fg", _v$9, _p$.t));
        _v$0 !== _p$.a && (_p$.a = _$setProp(_el$11, "attributes", _v$0, _p$.a));
        _v$1 !== _p$.o && (_p$.o = _$setProp(_el$12, "fg", _v$1, _p$.o));
        _v$10 !== _p$.i && (_p$.i = _$setProp(_el$15, "fg", _v$10, _p$.i));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined,
        i: undefined
      });
      return _el$9;
    })();
  };
  const todoRow = (item, index) => {
    const marker = item.status === "completed" ? "✓ " : item.status === "cancelled" ? "✕ " : item.status === "in_progress" ? "● " : "○ ";
    const colour = () => item.status === "completed" ? "#50fa7b" : item.status === "cancelled" ? "#ff5555" : item.status === "in_progress" ? hueHex(index, props.todoPhase()) : props.context.theme.text.muted;
    const attributes = item.status === "in_progress" || item.status === "completed" ? TextAttributes.BOLD : undefined;
    return (() => {
      var _el$16 = _$createElement("box"),
        _el$17 = _$createElement("text"),
        _el$18 = _$createElement("text");
      _$insertNode(_el$16, _el$17);
      _$insertNode(_el$16, _el$18);
      _$setProp(_el$16, "flexDirection", "row");
      _$setProp(_el$16, "width", "100%");
      _$setProp(_el$16, "columnGap", 1);
      _$setProp(_el$17, "wrapMode", "none");
      _$setProp(_el$17, "flexShrink", 0);
      _$setProp(_el$17, "attributes", attributes);
      _$setProp(_el$17, "selectable", false);
      _$insert(_el$17, marker);
      _$setProp(_el$18, "wrapMode", "word");
      _$setProp(_el$18, "flexShrink", 1);
      _$setProp(_el$18, "minWidth", 0);
      _$setProp(_el$18, "attributes", attributes);
      _$setProp(_el$18, "selectable", false);
      _$insert(_el$18, () => item.content);
      _$effect(_p$ => {
        var _v$11 = colour(),
          _v$12 = colour();
        _v$11 !== _p$.e && (_p$.e = _$setProp(_el$17, "fg", _v$11, _p$.e));
        _v$12 !== _p$.t && (_p$.t = _$setProp(_el$18, "fg", _v$12, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$16;
    })();
  };
  return (() => {
    var _el$19 = _$createElement("box");
    _$setProp(_el$19, "flexDirection", "column");
    _$setProp(_el$19, "gap", 0);
    _$setProp(_el$19, "width", "100%");
    _$insert(_el$19, _$createComponent(Show, {
      get when() {
        return props.settings.ui?.roster ?? true;
      },
      get children() {
        return [_$memo(() => header("agents", "AGENTS & MODELS", () => props.visibleAgentCount())), _$createComponent(Show, {
          get when() {
            return props.isOpen("agents");
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return props.agentList() !== undefined;
              },
              get fallback() {
                return (() => {
                  var _el$26 = _$createElement("text");
                  _$insertNode(_el$26, _$createTextNode(`roster unavailable`));
                  _$setProp(_el$26, "selectable", false);
                  _$effect(_$p => _$setProp(_el$26, "fg", props.context.theme.text.faint, _$p));
                  return _el$26;
                })();
              },
              get children() {
                var _el$20 = _$createElement("box"),
                  _el$21 = _$createElement("box"),
                  _el$22 = _$createElement("box"),
                  _el$23 = _$createElement("box");
                _$insertNode(_el$20, _el$21);
                _$insertNode(_el$20, _el$22);
                _$insertNode(_el$20, _el$23);
                _$setProp(_el$20, "flexDirection", "column");
                _$setProp(_el$20, "width", "100%");
                _$setProp(_el$20, "gap", 0);
                _$setProp(_el$21, "flexDirection", "column");
                _$setProp(_el$21, "width", "100%");
                _$insert(_el$21, () => header("primary", "PRIMARY", () => props.primary().length, true), null);
                _$insert(_el$21, _$createComponent(Show, {
                  get when() {
                    return props.isOpen("primary");
                  },
                  get children() {
                    return _$createComponent(For, {
                      get each() {
                        return props.primary();
                      },
                      children: agent => row(agent)
                    });
                  }
                }), null);
                _$setProp(_el$22, "flexDirection", "column");
                _$setProp(_el$22, "width", "100%");
                _$insert(_el$22, () => header("workers", "WORKERS", () => props.workers().length, true), null);
                _$insert(_el$22, _$createComponent(Show, {
                  get when() {
                    return props.isOpen("workers");
                  },
                  get children() {
                    return _$createComponent(For, {
                      get each() {
                        return props.workers();
                      },
                      children: agent => row(agent)
                    });
                  }
                }), null);
                _$setProp(_el$23, "flexDirection", "column");
                _$setProp(_el$23, "width", "100%");
                _$insert(_el$23, () => header("reviewers", "REVIEWERS", () => props.reviewers().length, true), null);
                _$insert(_el$23, _$createComponent(Show, {
                  get when() {
                    return props.isOpen("reviewers");
                  },
                  get children() {
                    return _$createComponent(For, {
                      get each() {
                        return props.reviewers();
                      },
                      children: agent => row(agent)
                    });
                  }
                }), null);
                return _el$20;
              }
            });
          }
        })];
      }
    }), null);
    _$insert(_el$19, _$createComponent(Show, {
      get when() {
        return _$memo(() => props.run().length > 0)() && (!(props.settings.ui?.roster ?? true) || props.isOpen("agents"));
      },
      get children() {
        var _el$24 = _$createElement("box");
        _$setProp(_el$24, "flexDirection", "column");
        _$setProp(_el$24, "width", "100%");
        _$setProp(_el$24, "marginTop", 1);
        _$insert(_el$24, _$createComponent(FlowingLabel, {
          get text() {
            return `RUNNING (${props.run().length})`;
          },
          get animate() {
            return props.settings.animations.running;
          }
        }), null);
        _$insert(_el$24, _$createComponent(For, {
          get each() {
            return props.run();
          },
          children: session => runningRow(session)
        }), null);
        return _el$24;
      }
    }), null);
    _$insert(_el$19, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!(props.settings.ui?.todos ?? true))() && props.todoItems().length > 0;
      },
      get children() {
        var _el$25 = _$createElement("box");
        _$setProp(_el$25, "flexDirection", "column");
        _$setProp(_el$25, "width", "100%");
        _$setProp(_el$25, "marginTop", 1);
        _$insert(_el$25, () => header("todos", "TODOS", () => `${props.todoDone()}/${props.todoItems().length}`), null);
        _$insert(_el$25, _$createComponent(Show, {
          get when() {
            return props.isOpen("todos");
          },
          get children() {
            return _$createComponent(For, {
              get each() {
                return props.todoItems().slice(0, TODO_LIMIT);
              },
              children: (item, index) => todoRow(item, index())
            });
          }
        }), null);
        return _el$25;
      }
    }), null);
    return _el$19;
  })();
}
