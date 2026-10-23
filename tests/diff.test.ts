import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { collapseEolOnlyChanges, summarizeChanges } from "../shared"

// A CRLF working tree over an LF blob makes unified diffs report every unchanged line as a -/+ pair that differs
// only by the trailing CR. Each fixture below is a patch the way a provider would hand it back.

const WHOLE_FILE_REWRITE = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,6 +1,7 @@
-alpha
+alpha\r
-beta
+beta\r
-gamma
+gamma\r
-delta
+delta\r
-epsilon
+epsilon\r
-zeta
+zeta\r
+added\r
`

const EOL_ONLY = `diff --git a/e.txt b/e.txt
--- a/e.txt
+++ b/e.txt
@@ -1,3 +1,3 @@
-one
+one\r
-two
+two\r
-three
+three\r
`

const REAL_EDIT_WITH_CR_ELSEWHERE = `diff --git a/r.txt b/r.txt
--- a/r.txt
+++ b/r.txt
@@ -1,3 +1,3 @@
-const a = 1
+const a = 2
-context
+context\r
-other
+other\r
`

const WHITESPACE_ONLY_NO_CR = `diff --git a/w.txt b/w.txt
--- a/w.txt
+++ b/w.txt
@@ -1,2 +1,2 @@
-	indented
+  indented
 unchanged
`

const IDENTICAL_TEXT_SAME_CR_STATE = `diff --git a/i.txt b/i.txt
--- a/i.txt
+++ b/i.txt
@@ -1,2 +1,2 @@
-same
+same
-other
+other\r
`

const REORDER = `diff --git a/o.txt b/o.txt
--- a/o.txt
+++ b/o.txt
@@ -1,2 +1,2 @@
-A
-B
+B\r
+A\r
`

const HEADER_ARITHMETIC = `diff --git a/h.txt b/h.txt
index 3333333..4444444 100644
--- a/h.txt
+++ b/h.txt
@@ -10,8 +10,9 @@ section
 ctx-a
-one
+one\r
-two
+two\r
-three
+three\r
-four
+four\r
-five
+five\r
-six
+six\r
+new\r
 ctx-b
`

const TWO_HUNKS = `diff --git a/m.txt b/m.txt
--- a/m.txt
+++ b/m.txt
@@ -1,2 +1,2 @@
-one
+one\r
-two
+two\r
@@ -10,2 +10,2 @@
-value = 1
+value = 2
-old
+old\r
`

const MARKER_DROPPED = `diff --git a/n.txt b/n.txt
--- a/n.txt
+++ b/n.txt
@@ -1,2 +1,2 @@
-keep = 1
+keep = 2
-old last
+old last\r
\\ No newline at end of file
`

const MARKER_KEPT = `diff --git a/n.txt b/n.txt
--- a/n.txt
+++ b/n.txt
@@ -1,2 +1,2 @@
-x
+x\r
-keep = 1
+keep = 2
\\ No newline at end of file
`

const PLAIN_NO_CR = `diff --git a/p.txt b/p.txt
--- a/p.txt
+++ b/p.txt
@@ -1,2 +1,3 @@
 keep
-old
+new
+extra
`

const MALFORMED_BODY = `diff --git a/q.txt b/q.txt
--- a/q.txt
+++ b/q.txt
@@ -1,2 +1,2 @@
-one
+one\r
* not a diff line
`

describe("collapseEolOnlyChanges", () => {
  test("keeps a genuinely new line and drops the six EOL-only pairs around it", () => {
    const result = collapseEolOnlyChanges(WHOLE_FILE_REWRITE)
    assert.ok(result !== undefined)
    assert.equal(result.additions, 1)
    assert.equal(result.deletions, 0)
    assert.ok(result.patch.startsWith("diff --git a/f.txt b/f.txt\n"))
    assert.ok(result.patch.includes("--- a/f.txt\n+++ b/f.txt\n"))
    assert.equal(
      result.patch,
      `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -6,0 +7 @@
+added\r
`
    )
  })

  test("returns undefined when the file differs only in line endings", () => {
    assert.equal(collapseEolOnlyChanges(EOL_ONLY), undefined)
  })

  test("keeps a real edit that has no CR while collapsing the CR pairs around it", () => {
    const result = collapseEolOnlyChanges(REAL_EDIT_WITH_CR_ELSEWHERE)
    assert.ok(result !== undefined)
    assert.equal(result.additions, 1)
    assert.equal(result.deletions, 1)
    assert.equal(
      result.patch,
      `diff --git a/r.txt b/r.txt
--- a/r.txt
+++ b/r.txt
@@ -1 +1 @@
-const a = 1
+const a = 2
`
    )
  })

  test("returns a patch without CR unchanged and counts every +/- line", () => {
    const result = collapseEolOnlyChanges(WHITESPACE_ONLY_NO_CR)
    assert.ok(result !== undefined)
    assert.equal(result.patch, WHITESPACE_ONLY_NO_CR)
    assert.equal(result.additions, 1)
    assert.equal(result.deletions, 1)
  })

  test("does not collapse identical text that carries the same CR state", () => {
    const result = collapseEolOnlyChanges(IDENTICAL_TEXT_SAME_CR_STATE)
    assert.ok(result !== undefined)
    assert.equal(result.additions, 1)
    assert.equal(result.deletions, 1)
    assert.equal(
      result.patch,
      `diff --git a/i.txt b/i.txt
--- a/i.txt
+++ b/i.txt
@@ -1 +1 @@
-same
+same
`
    )
  })

  test("keeps a reordered block visible instead of collapsing it", () => {
    const result = collapseEolOnlyChanges(REORDER)
    assert.ok(result !== undefined)
    assert.equal(result.additions, 2)
    assert.equal(result.deletions, 2)
    assert.ok(result.patch.includes("-A\n"))
    assert.ok(result.patch.includes("-B\n"))
    assert.ok(result.patch.includes("+A\r\n"))
    assert.ok(result.patch.includes("+B\r\n"))
  })

  test("recomputes the hunk header counts from the lines that survive", () => {
    const result = collapseEolOnlyChanges(HEADER_ARITHMETIC)
    assert.ok(result !== undefined)
    assert.equal(result.additions, 1)
    assert.equal(result.deletions, 0)
    assert.equal(
      result.patch,
      `diff --git a/h.txt b/h.txt
index 3333333..4444444 100644
--- a/h.txt
+++ b/h.txt
@@ -10,2 +10,3 @@ section
 ctx-a
+new\r
 ctx-b
`
    )
  })

  test("drops an EOL-only hunk and keeps the hunk with a real edit", () => {
    const result = collapseEolOnlyChanges(TWO_HUNKS)
    assert.ok(result !== undefined)
    assert.equal(result.additions, 1)
    assert.equal(result.deletions, 1)
    assert.equal(
      result.patch,
      `diff --git a/m.txt b/m.txt
--- a/m.txt
+++ b/m.txt
@@ -10 +10 @@
-value = 1
+value = 2
`
    )
  })

  test("drops a no-newline marker whose line was collapsed away", () => {
    const result = collapseEolOnlyChanges(MARKER_DROPPED)
    assert.ok(result !== undefined)
    assert.equal(result.additions, 1)
    assert.equal(result.deletions, 1)
    assert.ok(!result.patch.includes("No newline at end of file"))
    assert.equal(
      result.patch,
      `diff --git a/n.txt b/n.txt
--- a/n.txt
+++ b/n.txt
@@ -1 +1 @@
-keep = 1
+keep = 2
`
    )
  })

  test("keeps a no-newline marker whose line survived", () => {
    const result = collapseEolOnlyChanges(MARKER_KEPT)
    assert.ok(result !== undefined)
    assert.equal(result.additions, 1)
    assert.equal(result.deletions, 1)
    assert.ok(result.patch.includes("\\ No newline at end of file"))
    assert.equal(
      result.patch,
      `diff --git a/n.txt b/n.txt
--- a/n.txt
+++ b/n.txt
@@ -2 +2 @@
-keep = 1
+keep = 2
\\ No newline at end of file
`
    )
  })

  test("returns the same patch string and raw counts when the patch has no CR", () => {
    const result = collapseEolOnlyChanges(PLAIN_NO_CR)
    assert.ok(result !== undefined)
    assert.equal(result.patch, PLAIN_NO_CR)
    assert.equal(result.additions, 2)
    assert.equal(result.deletions, 1)
  })

  test("returns a patch with an unrecognized body line unchanged instead of throwing", () => {
    const captured: { value?: ReturnType<typeof collapseEolOnlyChanges> } = {}
    assert.doesNotThrow(() => {
      captured.value = collapseEolOnlyChanges(MALFORMED_BODY)
    })
    const result = captured.value
    assert.ok(result !== undefined)
    assert.equal(result.patch, MALFORMED_BODY)
    assert.equal(result.additions, 1)
    assert.equal(result.deletions, 1)
  })
})

describe("summarizeChanges", () => {
  test("reports no signals and only the correctness lens for a clean file", () => {
    assert.equal(
      summarizeChanges([{ file: "src/a.ts", patch: "const a = 1", additions: 1, deletions: 0 }]),
      "Risk: 1 files, +1 -0. Signals: none. Lenses: correctness.",
    )
  })

  test("reports an auth signal with the security lens", () => {
    assert.equal(
      summarizeChanges([{ file: "src/login.ts", patch: "check password", additions: 2, deletions: 1 }]),
      "Risk: 1 files, +2 -1. Signals: auth (src/login.ts). Lenses: correctness, security.",
    )
  })

  test("adds the data lens when sql matches alongside auth", () => {
    assert.equal(
      summarizeChanges([
        { file: "src/auth.ts", patch: "login check", additions: 1, deletions: 0 },
        { file: "src/query.ts", patch: "select id from users where id = 1", additions: 2, deletions: 3 },
      ]),
      "Risk: 2 files, +3 -3. Signals: auth (src/auth.ts), sql (src/query.ts). Lenses: correctness, security, data.",
    )
  })

  test("orders categories by definition, not by file order", () => {
    assert.equal(
      summarizeChanges([
        { file: "b.html", patch: "el.innerHTML = x", additions: 1, deletions: 0 },
        { file: "a.ts", patch: "password check", additions: 1, deletions: 0 },
      ]),
      "Risk: 2 files, +2 -0. Signals: auth (a.ts), html (b.html). Lenses: correctness, security.",
    )
  })

  test("caps signals at three and counts the rest", () => {
    assert.equal(
      summarizeChanges([
        { file: "a.ts", patch: "password check", additions: 1, deletions: 0 },
        { file: "b.ts", patch: "api_key = 1", additions: 1, deletions: 0 },
        { file: "c.ts", patch: "select id from users where id = 1", additions: 1, deletions: 0 },
        { file: "d.sh", patch: "child_process spawn", additions: 1, deletions: 0 },
        { file: "e.html", patch: "el.innerHTML = x", additions: 1, deletions: 0 },
      ]),
      "Risk: 5 files, +5 -0. Signals: auth (a.ts), secrets (b.ts), sql (c.ts) +2. Lenses: correctness, security, data.",
    )
  })

  test("flattens a newline in the filename onto one line", () => {
    const result = summarizeChanges([{ file: "bad\npath.ts", patch: "password check", additions: 1, deletions: 0 }])
    assert.equal(result, "Risk: 1 files, +1 -0. Signals: auth (bad path.ts). Lenses: correctness, security.")
    assert.ok(!result.includes("\n") && !result.includes("\u001B"))
  })

  test("strips an ANSI escape in the filename onto one line", () => {
    const result = summarizeChanges([{ file: "a\u001B[31mb.ts", patch: "password check", additions: 1, deletions: 0 }])
    assert.equal(result, "Risk: 1 files, +1 -0. Signals: auth (ab.ts). Lenses: correctness, security.")
    assert.ok(!result.includes("\n") && !result.includes("\u001B"))
  })

  test("sums additions and deletions across two files", () => {
    assert.equal(
      summarizeChanges([
        { file: "src/a.ts", patch: "const a = 1", additions: 2, deletions: 1 },
        { file: "src/b.ts", patch: "const b = 2", additions: 3, deletions: 4 },
      ]),
      "Risk: 2 files, +5 -5. Signals: none. Lenses: correctness.",
    )
  })

  test("does not signal auth or shell for role attribute and RegExp exec", () => {
    assert.equal(
      summarizeChanges([
        { file: "src/ui.ts", patch: 'const m = pattern.exec(text)\nrole="button"', additions: 2, deletions: 0 },
      ]),
      "Risk: 1 files, +2 -0. Signals: none. Lenses: correctness.",
    )
  })

  test("signals shell for execSync with the security lens", () => {
    assert.equal(
      summarizeChanges([
        { file: "scripts/build.ts", patch: 'execSync("rm -rf build")', additions: 1, deletions: 0 },
      ]),
      "Risk: 1 files, +1 -0. Signals: shell (scripts/build.ts). Lenses: correctness, security.",
    )
  })

  test("fires secrets on an uppercase API_KEY and adds the security lens", () => {
    assert.equal(
      summarizeChanges([{ file: "src/keys.ts", patch: 'API_KEY = "sk-live-1"', additions: 1, deletions: 0 }]),
      "Risk: 1 files, +1 -0. Signals: secrets (src/keys.ts). Lenses: correctness, security.",
    )
  })

  test("requires a trailing clause for a bare SELECT", () => {
    assert.equal(
      summarizeChanges([{ file: "src/ui.ts", patch: "Select an option from the list", additions: 1, deletions: 0 }]),
      "Risk: 1 files, +1 -0. Signals: none. Lenses: correctness.",
    )
    assert.equal(
      summarizeChanges([
        { file: "src/query.ts", patch: "SELECT id FROM users WHERE id = ?", additions: 1, deletions: 0 },
      ]),
      "Risk: 1 files, +1 -0. Signals: sql (src/query.ts). Lenses: correctness, security, data.",
    )
  })

  test("does not fire html for a markup variable without an unsafe sink", () => {
    assert.equal(
      summarizeChanges([
        { file: "src/note.ts", patch: "const markup = renderMarkdown(note)", additions: 1, deletions: 0 },
      ]),
      "Risk: 1 files, +1 -0. Signals: none. Lenses: correctness.",
    )
  })

  test("does not fire shell for a bare spawn call but does for execSync", () => {
    assert.equal(
      summarizeChanges([{ file: "src/game.ts", patch: "spawn(enemy)", additions: 1, deletions: 0 }]),
      "Risk: 1 files, +1 -0. Signals: none. Lenses: correctness.",
    )
    assert.equal(
      summarizeChanges([{ file: "scripts/build.ts", patch: 'execSync("git status")', additions: 1, deletions: 0 }]),
      "Risk: 1 files, +1 -0. Signals: shell (scripts/build.ts). Lenses: correctness, security.",
    )
  })
})
