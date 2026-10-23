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

const snapshotSchema = {
  type: "object",
  properties: {
    animations: animationsSchema,
    ui: uiSchema,
    steps: stepsSchema,
    defaults: defaultsSchema,
    managed: { type: "array", items: { type: "string" } },
  },
  required: ["animations", "ui", "steps", "defaults", "managed"],
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
    },
    additionalProperties: false,
  },
  output: snapshotSchema,
} as const

const updated = { schema: snapshotSchema } as const

export const ChoreographerRpc = Rpc.define({
  id: "openchoreographer",
  methods: { getSettings, setSettings },
  events: { updated },
})
