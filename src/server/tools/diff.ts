import type { Plugin } from "@opencode/plugin"
import { MAX_DIFF_CHARS, collapseEolOnlyChanges, summarizeChanges, validateDiffInput, type ValidatedDiffInput } from "../../shared/diff"

export function diffTool(ctx: Plugin.Context) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "diff",
      description: "Read the current changes; mode working is uncommitted, branch is against the merge base, committed is the last commit; output is per-file with status and counts, or pass stat: true for counts-only lines without patches.",
      input: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["working", "branch", "committed"] },
          base: { type: "string" },
          context: { type: "integer", minimum: 0, maximum: 10 },
          path: { type: "string" },
          stat: { type: "boolean" },
        },
        additionalProperties: false,
      },
      options: { permission: "read" },
      execute: async (input) => {
        let mode: ValidatedDiffInput["mode"] = "working"
        let stat = false
        try {
          const validated = validateDiffInput(input)
          mode = validated.mode
          stat = validated.stat
          const { base, context, path } = validated
          const { data } = await ctx.vcs.diff({ mode, base, context })
          const needle = path
          const scoped = needle ? data.filter((entry) => entry.file.includes(needle)) : data
          if (scoped.length === 0) {
            if (needle && data.length > 0) {
              return { content: `No files match path "${needle}". ${data.length} files changed in mode ${mode}.`, metadata: { files: 0, mode, ...(stat ? { stat: true as const } : {}) } }
            }
            return { content: base ? `No changes in mode ${mode} against ${base}.` : `No changes in mode ${mode}.`, metadata: { files: 0, mode, ...(stat ? { stat: true as const } : {}) } }
          }
          // A CRLF working tree over LF blobs turns every modified file into a whole-file rewrite; collapse those
          // pairs first so the summary, the counts, and the 60k budget all describe what actually changed.
          const changed = scoped.flatMap((entry) => {
            const collapsed = collapseEolOnlyChanges(entry.patch)
            return collapsed === undefined ? [] : [{ entry, collapsed }]
          })
          if (changed.length === 0) {
            return { content: base ? `No changes in mode ${mode} against ${base}.` : `No changes in mode ${mode}.`, metadata: { files: 0, mode, ...(stat ? { stat: true as const } : {}) } }
          }
          const header = summarizeChanges(
            changed.map(({ entry, collapsed }) => ({
              file: entry.file,
              patch: collapsed.patch,
              additions: collapsed.additions,
              deletions: collapsed.deletions,
            })),
          )
          const blocks = stat
            ? [
                header,
                ...changed.map(({ entry, collapsed }) => {
                  const file = entry.file.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
                  return `${entry.status} ${file} +${collapsed.additions} -${collapsed.deletions}`
                }),
              ]
            : [
                header,
                ...changed.map(({ entry, collapsed }) => {
                const file = entry.file.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
                const patch = collapsed.patch.replace(/\u001B\[[0-9;]*m/g, "").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
                return `${file} (${entry.status} +${collapsed.additions} -${collapsed.deletions})\n${patch}`
                }),
              ]
          const total = blocks.reduce((sum, block) => sum + block.length, 0) + (blocks.length > 1 ? (blocks.length - 1) * 2 : 0)
          const kept: string[] = []
          let keptLength = 0
          for (const block of blocks) {
            kept.push(block)
            keptLength += block.length + (kept.length > 1 ? 2 : 0)
            if (keptLength > MAX_DIFF_CHARS) break
          }
          let text = kept.join("\n\n")
          if (text.length > MAX_DIFF_CHARS) {
            let cut = text.lastIndexOf("\n", MAX_DIFF_CHARS)
            if (cut < 0) cut = MAX_DIFF_CHARS
            if (cut > 0 && cut < text.length) {
              const low = text.charCodeAt(cut - 1)
              if (low >= 0xd800 && low <= 0xdbff) cut -= 1
            }
            const shown = cut
            text = text.slice(0, cut) + `\n… truncated at 60000 chars (showing ${shown} of ${total}); pass path to narrow, or base to compare against another ref`
            return { content: text, metadata: { files: changed.length, mode, truncated: true, total, ...(stat ? { stat: true as const } : {}) } }
          }
          return { content: text, metadata: { files: changed.length, mode, ...(stat ? { stat: true as const } : {}) } }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { content: `diff unavailable: ${message}`, metadata: { files: 0, mode, error: true, ...(stat ? { stat: true as const } : {}) } }
        }
      },
    })
  })
}
