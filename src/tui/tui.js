import { createComponent as _$createComponent } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { isReviewer, SUBAGENT_IDS } from "../shared/agents";
import { parseModel } from "../shared/fallback";
import { isSidebarStatusEvent, shouldRefreshSidebar } from "../shared/events";
import { defaultSettings, normalizeSnapshot } from "../shared/settings";
import { ChoreographerRpc } from "../shared/rpc";
import { modelName, normalizeTodoStatus, sanitize } from "./format";
import { SettingsPanel } from "./settings-panel.js";
import { Sidebar } from "./sidebar.js";
export default Plugin.define({
  id: "openchoreographer.tui",
  async setup(context) {
    const location = context.location ?? context.data.location.default();
    const [dataVersion, setDataVersion] = createSignal(0);
    const bump = () => setDataVersion(n => n + 1);
    const [metadataVersion, setMetadataVersion] = createSignal(0);
    const [currentSession, setCurrentSession] = createSignal(undefined);
    const sync = async notify => {
      const results = await Promise.allSettled([context.data.location.agent.sync(location), context.data.location.model.sync(location)]);
      if (notify && results.some(result => result.status === "rejected")) {
        context.ui.toast.show({
          message: "Agent roster unavailable",
          variant: "warning"
        });
      }
      bump();
    };
    void sync(true);
    const [settings, setSettings] = context.storage.store("openchoreographer.settings", {
      initial: defaultSettings()
    });
    const loadedUi = settings.ui;
    if (loadedUi === undefined || typeof loadedUi.todos !== "boolean" || typeof loadedUi.roster !== "boolean") {
      void setSettings(draft => {
        const existing = draft.ui;
        draft.ui = {
          todos: typeof existing?.todos === "boolean" ? existing.todos : false,
          roster: typeof existing?.roster === "boolean" ? existing.roster : true
        };
      });
    }
    const [configured, setConfigured] = createSignal({});
    const [subagents, setSubagents] = createSignal([]);
    const [routing, setRouting] = createSignal({});
    const [switchArmed, setSwitchArmed] = createSignal(undefined);
    const [switchBusyMap, setSwitchBusyMap] = createSignal({});
    const [online, setOnline] = createSignal(true);
    let inflight = 0;
    let mutation = 0;
    let disposed = false;
    const rpc = context.client.rpc(ChoreographerRpc);
    const callOptions = {
      location: {
        directory: location.directory
      }
    };
    const stringRecordSame = (a, b) => {
      const keys = Object.keys(b);
      return Object.keys(a).length === keys.length && keys.every(key => a[key] === b[key]);
    };
    const stringListRecordSame = (a, b) => {
      const keys = Object.keys(b);
      if (Object.keys(a).length !== keys.length) return false;
      return keys.every(key => {
        const left = a[key] ?? [];
        const right = b[key] ?? [];
        return left.length === right.length && right.every((value, index) => left[index] === value);
      });
    };
    const routingSame = (a, b) => {
      const keys = Object.keys(b);
      return Object.keys(a).length === keys.length && keys.every(key => a[key]?.model === b[key].model && a[key]?.fallback === b[key].fallback);
    };
    const copyFallback = value => {
      const copy = {};
      for (const [key, entry] of Object.entries(value)) copy[key] = [...entry];
      return copy;
    };
    const applySnapshot = value => {
      const snap = normalizeSnapshot(value);
      if (snap === undefined) return;
      const animationsSame = settings.animations.todo === snap.animations.todo && settings.animations.running === snap.animations.running;
      const uiSame = (settings.ui?.todos ?? false) === snap.ui.todos && (settings.ui?.roster ?? true) === snap.ui.roster;
      const currentModels = settings.models ?? {
        primary: {},
        fallback: {}
      };
      const modelsSame = stringRecordSame(currentModels.primary ?? {}, snap.models.primary) && stringListRecordSame(currentModels.fallback ?? {}, snap.models.fallback);
      const configuredSame = stringRecordSame(configured(), snap.configured);
      const currentSubagents = subagents();
      const subagentsSame = currentSubagents.length === snap.subagents.length && snap.subagents.every((id, index) => currentSubagents[index] === id);
      const maxParallelSame = settings.maxParallel === snap.maxParallel;
      const routingCheckSame = routingSame(routing(), snap.routing);
      if (animationsSame && uiSame && modelsSame && configuredSame && subagentsSame && maxParallelSame && routingCheckSame) return;
      batch(() => {
        void setSettings(draft => {
          draft.animations = {
            todo: snap.animations.todo,
            running: snap.animations.running
          };
          draft.ui = {
            todos: snap.ui.todos,
            roster: snap.ui.roster
          };
          draft.models = {
            primary: {
              ...snap.models.primary
            },
            fallback: copyFallback(snap.models.fallback)
          };
          draft.maxParallel = snap.maxParallel;
        });
        setConfigured({
          ...snap.configured
        });
        setSubagents([...snap.subagents]);
        setRouting({
          ...snap.routing
        });
        bump();
      });
    };
    const syncSettings = async notify => {
      const at = mutation;
      try {
        const snap = await rpc.getSettings({}, callOptions);
        if (at !== mutation) return true;
        applySnapshot(snap);
        setOnline(true);
        return true;
      } catch {
        setOnline(false);
        if (notify) context.ui.toast.show({
          message: "Choreographer settings unavailable",
          variant: "warning"
        });
        return false;
      }
    };
    const settle = () => {
      inflight -= 1;
    };
    void syncSettings(false).then(ok => {
      if (ok || disposed) return;
      setTimeout(() => {
        if (!disposed) void syncSettings(true);
      }, 1000);
    });
    let offSettings;
    try {
      offSettings = rpc.events.on("updated", event => {
        if (inflight !== 0) return;
        applySnapshot(event.data);
      });
    } catch {}
    const toggleAnimation = key => {
      const value = !settings.animations[key];
      mutation += 1;
      void setSettings(draft => {
        draft.animations[key] = value;
      });
      bump();
      inflight += 1;
      void rpc.setSettings({
        animations: key === "todo" ? {
          todo: value
        } : {
          running: value
        }
      }, callOptions).catch(() => {
        setOnline(false);
        context.ui.toast.show({
          message: "Choreographer settings unavailable",
          variant: "warning"
        });
      }).finally(settle);
    };
    const toggleUi = key => {
      const value = !(settings.ui?.[key] ?? (key === "todos" ? false : true));
      mutation += 1;
      void setSettings(draft => {
        draft.ui = {
          ...(draft.ui ?? {
            todos: false,
            roster: true
          }),
          [key]: value
        };
      });
      bump();
      inflight += 1;
      void rpc.setSettings({
        ui: key === "todos" ? {
          todos: value
        } : {
          roster: value
        }
      }, callOptions).catch(() => {
        setOnline(false);
        context.ui.toast.show({
          message: "Choreographer settings unavailable",
          variant: "warning"
        });
      }).finally(settle);
    };
    const saveMaxParallel = value => {
      const prev = settings.maxParallel;
      mutation += 1;
      const at = mutation;
      void setSettings(draft => {
        draft.maxParallel = value;
      });
      bump();
      inflight += 1;
      void rpc.setSettings({
        maxParallel: value
      }, callOptions).then(snap => {
        if (at === mutation) applySnapshot(snap);
      }).catch(() => {
        setOnline(false);
        context.ui.toast.show({
          message: "Could not save max parallel: server plugin unreachable",
          variant: "warning"
        });
        if (at === mutation) {
          void setSettings(draft => {
            draft.maxParallel = prev;
          });
        } else {
          void syncSettings(false);
        }
      }).finally(settle);
    };
    const modelSettings = () => settings.models ?? {
      primary: {},
      fallback: {}
    };
    const savePrimary = (ids, ref) => {
      const before = {
        primary: {
          ...modelSettings().primary
        },
        fallback: copyFallback(modelSettings().fallback)
      };
      mutation += 1;
      const at = mutation;
      void setSettings(draft => {
        const current = draft.models ?? {
          primary: {},
          fallback: {}
        };
        const primary = {
          ...(current.primary ?? {})
        };
        for (const id of ids) {
          if (ref === null) delete primary[id];else primary[id] = ref;
        }
        draft.models = {
          primary,
          fallback: {
            ...(current.fallback ?? {})
          }
        };
      });
      bump();
      inflight += 1;
      const payload = {};
      for (const id of ids) payload[id] = ref;
      return rpc.setSettings({
        models: {
          primary: payload
        }
      }, callOptions).then(snap => {
        if (at === mutation) applySnapshot(snap);
        return true;
      }).catch(() => {
        setOnline(false);
        context.ui.toast.show({
          message: "Could not save model settings: server plugin unreachable",
          variant: "warning"
        });
        if (at === mutation) {
          void setSettings(draft => {
            draft.models = {
              primary: {
                ...before.primary
              },
              fallback: copyFallback(before.fallback)
            };
          });
        } else {
          void syncSettings(false);
        }
        return false;
      }).finally(settle);
    };
    const saveFallback = (ids, refs) => {
      const before = {
        primary: {
          ...modelSettings().primary
        },
        fallback: copyFallback(modelSettings().fallback)
      };
      mutation += 1;
      const at = mutation;
      void setSettings(draft => {
        const current = draft.models ?? {
          primary: {},
          fallback: {}
        };
        const fallback = copyFallback(current.fallback ?? {});
        for (const id of ids) {
          if (refs === null) delete fallback[id];else fallback[id] = [...refs];
        }
        draft.models = {
          primary: {
            ...(current.primary ?? {})
          },
          fallback
        };
      });
      bump();
      inflight += 1;
      const payload = {};
      for (const id of ids) payload[id] = refs === null ? null : [...refs];
      return rpc.setSettings({
        models: {
          fallback: payload
        }
      }, callOptions).then(snap => {
        if (at === mutation) applySnapshot(snap);
        return true;
      }).catch(() => {
        setOnline(false);
        context.ui.toast.show({
          message: "Could not save model settings: server plugin unreachable",
          variant: "warning"
        });
        if (at === mutation) {
          void setSettings(draft => {
            draft.models = {
              primary: {
                ...before.primary
              },
              fallback: copyFallback(before.fallback)
            };
          });
        } else {
          void syncSettings(false);
        }
        return false;
      }).finally(settle);
    };
    const agentById = id => (agentList() ?? []).find(agent => agent.id === id);
    const isSwitchPending = agent => {
      const armed = switchArmed();
      return armed !== undefined && armed.session === currentSession() && armed.agent === agent.id;
    };
    const isSwitchBusy = agent => switchBusyMap()[agent.id] === true;
    const requestSwitch = id => {
      const session = currentSession();
      if (session === undefined) return;
      if (switchBusyMap()[id] === true) return;
      const armed = switchArmed();
      if (armed === undefined || armed.session !== session || armed.agent !== id) {
        setSwitchArmed({
          session,
          agent: id
        });
        return;
      }
      mutation += 1;
      const at = mutation;
      setSwitchArmed(undefined);
      setSwitchBusyMap(state => ({
        ...state,
        [id]: true
      }));
      inflight += 1;
      void rpc.resetModel({
        agent: id
      }, callOptions).then(snap => {
        if (at === mutation) applySnapshot(snap);
      }).catch(() => {
        setOnline(false);
        context.ui.toast.show({
          message: "Could not restore primary model: server plugin unreachable",
          variant: "warning"
        });
        void syncSettings(false);
      }).finally(() => {
        setSwitchBusyMap(state => {
          if (state[id] !== true) return state;
          const next = {
            ...state
          };
          delete next[id];
          return next;
        });
        settle();
      });
    };
    const openSettings = () => {
      if (inflight === 0) void syncSettings(false);
      context.ui.dialog.set({
        size: "large",
        centered: true
      });
      context.ui.dialog.show(() => _$createComponent(SettingsPanel, {
        context: context,
        settings: settings,
        online: online,
        agentById: agentById,
        toggleAnimation: toggleAnimation,
        toggleUi: toggleUi,
        saveMaxParallel: saveMaxParallel,
        catalog: models,
        modelSettings: modelSettings,
        configured: configured,
        subagents: subagents,
        savePrimary: savePrimary,
        saveFallback: saveFallback
      }));
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "openchoreographer.settings",
        title: "Choreographer settings",
        description: "Openchoreographer settings panel",
        group: "openchoreographer",
        palette: true,
        slash: {
          name: "choreographer"
        },
        run: () => openSettings()
      }]
    }));
    const agentList = createMemo(() => {
      dataVersion();
      return context.data.location.agent.list(location);
    });
    const models = createMemo(() => {
      dataVersion();
      return context.data.location.model.list(location) ?? [];
    });
    const modelIndex = createMemo(() => {
      const index = new Map();
      for (const model of models()) {
        const label = model?.name?.trim() || `${model.providerID}/${model.id}`;
        index.set(`${model.providerID}/${model.id}`, label);
        if (model.modelID && model.modelID !== model.id) index.set(`${model.providerID}/${model.modelID}`, label);
      }
      return index;
    });
    const subagentList = createMemo(() => {
      return (agentList() ?? []).filter(agent => !agent.hidden && agent.mode === "subagent" && SUBAGENT_IDS.includes(agent.id)).sort((a, b) => a.name.localeCompare(b.name));
    });
    const primary = createMemo(() => {
      return (agentList() ?? []).filter(agent => !agent.hidden && agent.mode !== "subagent").sort((a, b) => a.name.localeCompare(b.name));
    });
    const reviewers = createMemo(() => {
      return subagentList().filter(agent => isReviewer(agent.id));
    });
    const workers = createMemo(() => {
      return subagentList().filter(agent => !isReviewer(agent.id));
    });
    const visibleAgentCount = createMemo(() => {
      return primary().length + subagentList().length;
    });
    const [open, setOpen] = createSignal({});
    const DEFAULT_OPEN = {
      agents: true,
      primary: false,
      workers: false,
      reviewers: false,
      todos: true
    };
    const isOpen = (sessionID, section) => open()[sessionID]?.[section] ?? DEFAULT_OPEN[section];
    const toggle = (sessionID, section) => {
      const next = !isOpen(sessionID, section);
      setOpen(state => ({
        ...state,
        [sessionID]: {
          ...(state[sessionID] ?? DEFAULT_OPEN),
          [section]: next
        }
      }));
      setSwitchArmed(undefined);
    };
    const activeModel = (agent, sessionID) => {
      dataVersion();
      const routed = routing()[agent.id];
      if (routed !== undefined) {
        const parsed = parseModel(routed.model);
        if (parsed === undefined) return routed.model;
        return modelName({
          providerID: parsed.providerID,
          id: parsed.modelID,
          variant: parsed.variant
        }, modelIndex());
      }
      const session = context.data.session.get(sessionID);
      if (session?.agent === agent.id && session.model) return modelName(session.model, modelIndex());
      const override = modelSettings().primary[agent.id];
      if (override !== undefined) {
        const parsed = parseModel(override);
        if (parsed === undefined) return override;
        return modelName({
          providerID: parsed.providerID,
          id: parsed.modelID,
          variant: parsed.variant
        }, modelIndex());
      }
      return agent.model ? modelName(agent.model, modelIndex()) : "inherit";
    };
    const fallbackModel = agent => routing()[agent.id]?.fallback === true;
    const running = () => {
      dataVersion();
      const sessionID = currentSession();
      if (sessionID === undefined) return [];
      const result = [];
      for (const id of context.data.session.family(sessionID)) {
        if (id === sessionID) continue;
        const session = context.data.session.get(id);
        if (session?.parentID && context.data.session.status(id) === "running") result.push(session);
      }
      return result;
    };
    const todoCache = new WeakMap();
    const todoItems = sessionID => {
      dataVersion();
      const version = metadataVersion();
      const raw = context.data.session.get(sessionID)?.metadata?.["openchoreographer.todos"];
      if (!Array.isArray(raw)) return [];
      const cached = todoCache.get(raw);
      if (cached !== undefined && cached.raw === raw && cached.version === version) return cached.items;
      const items = [];
      for (const entry of raw) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry;
        const content = record.content;
        if (typeof content !== "string") continue;
        items.push({
          id: typeof record.id === "string" ? record.id : undefined,
          content: sanitize(content),
          status: normalizeTodoStatus(record.status)
        });
      }
      todoCache.set(raw, {
        raw,
        version,
        items
      });
      return items;
    };
    const todoDone = sessionID => todoItems(sessionID).filter(item => item.status === "completed" || item.status === "cancelled").length;
    const [todoPhase, setTodoPhase] = createSignal(0);
    const [todoAnimFor, setTodoAnimFor] = createSignal(undefined);
    let todoTimer;
    createEffect(() => {
      const sessionID = todoAnimFor();
      const active = sessionID !== undefined && (settings.ui?.todos ?? false) && settings.animations.todo && isOpen(sessionID, "todos") && todoItems(sessionID).some(item => item.status === "in_progress");
      if (active && todoTimer === undefined) {
        todoTimer = setInterval(() => {
          setTodoPhase(value => value + 3);
        }, 120);
      } else if (!active && todoTimer !== undefined) {
        clearInterval(todoTimer);
        todoTimer = undefined;
      }
    });
    let refreshToasted = false;
    let pendingRoster = false;
    const refresh = async syncRoster => {
      if (syncRoster) {
        context.data.location.agent.invalidate(location);
        context.data.location.model.invalidate(location);
      }
      const current = currentSession();
      const ids = current !== undefined ? [...context.data.session.family(current)] : [];
      for (const id of ids) {
        try {
          context.data.session.invalidate(id);
        } catch {/* per-session failures retry on the next event */}
      }
      await Promise.allSettled(ids.map(id => context.data.session.sync(id)));
      if (syncRoster) {
        const results = await Promise.allSettled([context.data.location.agent.sync(location), context.data.location.model.sync(location)]);
        if (results.some(result => result.status === "rejected") && !refreshToasted) {
          refreshToasted = true;
          context.ui.toast.show({
            message: "Agent roster unavailable",
            variant: "warning"
          });
        }
      }
      bump();
    };
    let timer;
    let refreshing = false;
    let pending = false;
    const runRefresh = () => {
      timer = undefined;
      refreshing = true;
      const syncRoster = pendingRoster;
      pendingRoster = false;
      pending = false;
      void refresh(syncRoster).finally(() => {
        refreshing = false;
        if (pending) {
          pending = false;
          timer = setTimeout(runRefresh, 250);
        }
      });
    };
    const scheduleStructural = type => {
      if (type === "agent.updated" || type === "model.updated") pendingRoster = true;
      if (refreshing) {
        pending = true;
        return;
      }
      if (timer === undefined) timer = setTimeout(runRefresh, 250);
    };
    const run = createMemo(() => running());
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: ({
        sessionID
      }) => {
        if (currentSession() !== sessionID) {
          setCurrentSession(sessionID);
          setSwitchArmed(undefined);
        }
        if (todoAnimFor() !== sessionID) setTodoAnimFor(sessionID);
        return _$createComponent(Sidebar, {
          context: context,
          sessionID: sessionID,
          settings: settings,
          isOpen: section => isOpen(sessionID, section),
          toggle: section => toggle(sessionID, section),
          agentList: agentList,
          primary: primary,
          workers: workers,
          reviewers: reviewers,
          visibleAgentCount: visibleAgentCount,
          run: run,
          modelIndex: modelIndex,
          activeModel: agent => activeModel(agent, sessionID),
          fallbackModel: fallbackModel,
          switchPending: isSwitchPending,
          switchBusy: isSwitchBusy,
          requestSwitch: requestSwitch,
          todoItems: () => todoItems(sessionID),
          todoDone: () => todoDone(sessionID),
          todoPhase: todoPhase,
          dataVersion: dataVersion
        });
      }
    });
    const offListen = context.data.listen(event => {
      const type = event.details.type;
      if (type === "session.metadata.updated" || type === "session.deleted") setMetadataVersion(n => n + 1);
      if (shouldRefreshSidebar(type)) scheduleStructural(type);else if (isSidebarStatusEvent(type)) bump();
    });
    return () => {
      unregister();
      offListen();
      disposed = true;
      offSettings?.();
      if (timer !== undefined) clearTimeout(timer);
      if (todoTimer !== undefined) clearInterval(todoTimer);
    };
  }
});
