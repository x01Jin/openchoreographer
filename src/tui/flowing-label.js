import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { FLOW } from "./format";
export function FlowingLabel(props) {
  const [phase, setPhase] = createSignal(0);
  createEffect(() => {
    if (!props.animate) return;
    const timer = setInterval(() => setPhase(value => value + 1), 220);
    onCleanup(() => clearInterval(timer));
  });
  const chars = createMemo(() => Array.from(props.text));
  return _$createComponent(Show, {
    get when() {
      return props.animate;
    },
    get fallback() {
      return (() => {
        var _el$2 = _$createElement("text");
        _$setProp(_el$2, "selectable", false);
        _$insert(_el$2, () => props.text);
        _$effect(_p$ => {
          var _v$ = FLOW[0],
            _v$2 = TextAttributes.BOLD;
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$2, "attributes", _v$2, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$2;
      })();
    },
    get children() {
      var _el$ = _$createElement("box");
      _$setProp(_el$, "flexDirection", "row");
      _$insert(_el$, _$createComponent(For, {
        get each() {
          return chars();
        },
        children: (char, index) => (() => {
          var _el$3 = _$createElement("text");
          _$setProp(_el$3, "selectable", false);
          _$insert(_el$3, char);
          _$effect(_p$ => {
            var _v$3 = FLOW[((index() - phase()) % FLOW.length + FLOW.length) % FLOW.length],
              _v$4 = TextAttributes.BOLD;
            _v$3 !== _p$.e && (_p$.e = _$setProp(_el$3, "fg", _v$3, _p$.e));
            _v$4 !== _p$.t && (_p$.t = _$setProp(_el$3, "attributes", _v$4, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$3;
        })()
      }));
      return _el$;
    }
  });
}
