import { Rpc } from "@opencode/plugin/rpc"

const animationsSchema = {
  type: "object",
  properties: {
    todo: { type: "boolean" },
    running: { type: "boolean" },
  },
  required: ["todo", "running"],
  additionalProperties: false,
} as const

const uiSchema = {
  type: "object",
  properties: {
    todos: { type: "boolean" },
    roster: { type: "boolean" },
  },
  required: ["todos", "roster"],
  additionalProperties: false,
} as const

const stepsSchema = {
  type: "object",
  additionalProperties: { type: "integer" },
} as const

const defaultsSchema = {
  type: "object",
  additionalProperties: { type: ["integer", "null"] },
} as const

const modelsSchema = {
  type: "object",
  properties: {
    primary: { type: "object", additionalProperties: { type: "string" } },
    fallback: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
  },
  required: ["primary", "fallback"],
  additionalProperties: false,
} as const

const configuredSchema = {
  type: "object",
  additionalProperties: { type: ["string", "null"] },
} as const

const subagentsSchema = {
  type: "array",
  items: { type: "string" },
} as const

const disabledSchema = {
  type: "array",
  items: { type: "string" },
  maxItems: 32,
} as const

const routingSchema = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: {
      model: { type: "string" },
      fallback: { type: "boolean" },
    },
    required: ["model", "fallback"],
    additionalProperties: false,
  },
} as const

const snapshotSchema = {
  type: "object",
  properties: {
    animations: animationsSchema,
    ui: uiSchema,
    steps: stepsSchema,
    defaults: defaultsSchema,
    managed: { type: "array", items: { type: "string" } },
    models: modelsSchema,
    configured: configuredSchema,
    subagents: subagentsSchema,
    disabled: disabledSchema,
    maxParallel: { type: "integer", minimum: 1, maximum: 8 },
    routing: routingSchema,
  },
  required: ["animations", "ui", "steps", "defaults", "managed", "models", "configured", "subagents", "disabled", "maxParallel", "routing"],
  additionalProperties: false,
} as const

const getSettings = {
  input: { type: "object", properties: {}, additionalProperties: false },
  output: snapshotSchema,
} as const

const setSettings = {
  input: {
    type: "object",
    properties: {
      animations: {
        type: "object",
        properties: {
          todo: { type: "boolean" },
          running: { type: "boolean" },
        },
        additionalProperties: false,
      },
      steps: {
        type: "object",
        additionalProperties: { type: ["integer", "null"] },
      },
      ui: {
        type: "object",
        properties: {
          todos: { type: "boolean" },
          roster: { type: "boolean" },
        },
        additionalProperties: false,
      },
      models: {
        type: "object",
        properties: {
          primary: { type: "object", additionalProperties: { type: ["string", "null"] } },
          fallback: { type: "object", additionalProperties: { type: ["array", "null"], items: { type: "string" } } },
        },
        additionalProperties: false,
      },
      disabled: disabledSchema,
      maxParallel: { type: "integer", minimum: 1, maximum: 8 },
    },
    additionalProperties: false,
  },
  output: snapshotSchema,
} as const

const updated = { schema: snapshotSchema } as const

const resetModel = {
  input: {
    type: "object",
    properties: {
      agent: { type: "string", maxLength: 64 },
    },
    required: ["agent"],
    additionalProperties: false,
  },
  output: snapshotSchema,
} as const

export const ChoreographerRpc = Rpc.define({
  id: "openchoreographer",
  methods: { getSettings, setSettings, resetModel },
  events: { updated },
})
