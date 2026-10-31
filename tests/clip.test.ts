import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { clipShellOutput, clipShellParts, clipSubagentReports, type ShellPart } from "../src/shared/results";

const SHELL_MARKER = /\n… (\d+) chars dropped \(shell output over (\d+)\)\n/;
const REPORT_MARKER = /\n… (\d+) chars dropped \(subagent report over (\d+); the child session holds the full text\)\n/;
const C0 = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

function loneSurrogates(text: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) found.push(`high@${index}`);
      else index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      found.push(`low@${index}`);
    }
  }
  return found;
}

function shellOutput(): string {
  const middle = Array.from({ length: 400 }, (_, index) => `  ok middle case ${index} ${"x".repeat(20)}`);
  return ["$ npm test", ...middle, "", "  tests 412", "  fail 0"].join("\n");
}

function padded(lines: number, size = 40): string {
  return Array.from({ length: lines }, (_, index) => `middle line ${index} ${"x".repeat(size)}`).join("\n");
}

function subagentReport(body: string): string {
  const head = ['<subagent sessionID="ses_abc123" state="completed">', "TASK: clip shell output", "FILES: src/shared/results.ts modified 40"];
  return [...head, body, "BLOCKED: nothing", "RISK: none", "</subagent>"].join("\n");
}

function longReport(body = padded(120, 30)): string {
  return subagentReport(body);
}

describe("clipShellOutput", () => {
  test("returns text at or under the limit unchanged", () => {
    assert.deepEqual(clipShellOutput(""), { text: "", dropped: 0 });
    assert.deepEqual(clipShellOutput("short output"), { text: "short output", dropped: 0 });
    const exact = "a".repeat(6_000);
    assert.deepEqual(clipShellOutput(exact), { text: exact, dropped: 0 });
  });

  test("never exceeds the default limit", () => {
    const text = shellOutput();
    assert.ok(text.length > 6_000, `fixture is only ${text.length} chars`);
    const out = clipShellOutput(text).text;
    assert.ok(out.length <= 6_000, `got ${out.length}`);
    assert.match(out, SHELL_MARKER);
  });

  test("honours a custom limit", () => {
    const text = "b".repeat(5_000);
    assert.deepEqual(clipShellOutput(text, 0), { text: "", dropped: 5_000 });
    const out = clipShellOutput(text, 500).text;
    assert.ok(out.length <= 500, `got ${out.length}`);
    const matched = out.match(SHELL_MARKER);
    assert.ok(matched !== null, "missing drop marker");
    assert.equal(Number(matched[2]), 500);
  });

  test("keeps the first line at the head and the last line at the tail", () => {
    const text = shellOutput();
    const out = clipShellOutput(text).text;
    assert.ok(out.startsWith("$ npm test\n"), "head lost the command line");
    assert.ok(out.endsWith("\n  fail 0"), "tail lost the summary line");
    assert.ok(!out.includes("middle case 200 "), "middle should be dropped");
  });

  test("the marker reports the exact number of dropped characters", () => {
    const text = shellOutput();
    const out = clipShellOutput(text).text;
    const matched = out.match(SHELL_MARKER);
    assert.ok(matched !== null, "missing drop marker");
    const kept = out.length - matched[0].length;
    assert.equal(Number(matched[1]), text.length - kept);
    assert.equal(Number(matched[2]), 6_000);
  });

  test("never splits a surrogate pair into a lone surrogate", () => {
    const text = "🙂".repeat(6_000);
    for (const limit of [0, 1, 2, 40, 80, 1_000, 6_000]) {
      const out = clipShellOutput(text, limit).text;
      assert.ok(out.length <= limit, `limit ${limit}: got ${out.length}`);
      assert.deepEqual(loneSurrogates(out), [], `limit ${limit}`);
    }
  });

  test("strips ANSI SGR and C0 controls before clipping and still holds the limit", () => {
    const noisy = Array.from({ length: 400 }, (_, index) => `\u001B[32m+ ok ${index}\u001B[0m\u0000\u0007 ${"y".repeat(30)}`);
    const text = noisy.join("\n");
    const out = clipShellOutput(text).text;
    assert.ok(out.length <= 6_000, `got ${out.length}`);
    assert.ok(!out.includes("\u001B"), "ANSI escape survived");
    assert.equal(C0.test(out), false, "C0 control survived");
    assert.match(out, SHELL_MARKER);
    // Escape codes count as dropped even though they never reach the marker arithmetic.
    assert.ok(clipShellOutput("\u001B[31mok\u001B[0m").dropped > 0);
  });
});

describe("clipShellParts", () => {
  test("shares one budget across every text part", () => {
    const parts = Array.from({ length: 5 }, () => ({ type: "text", text: "p".repeat(7_000) }));
    const out = clipShellParts(parts);
    const total = out.parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0);
    assert.ok(total <= 6_000, `total is ${total}`);
    assert.equal(out.dropped, 35_000 - total);
    assert.ok(out.parts.some((part) => SHELL_MARKER.test(part.text ?? "")), "missing drop marker");
  });

  test("labels the marker with the whole-call cap", () => {
    const parts = Array.from({ length: 5 }, () => ({ type: "text", text: "p".repeat(7_000) }));
    const out = clipShellParts(parts);
    assert.ok(out.parts.some((part) => /\(shell output over 6000\)/.test(part.text ?? "")), "missing whole-call cap label");
  });

  test("keeps non-text parts and leaves short text parts untouched", () => {
    const first = { type: "text", text: "line one\nline two" };
    const file = { type: "file", uri: "file:///tmp/a.txt", name: "a.txt" };
    const last = { type: "text", text: "  fail 0" };
    const out = clipShellParts([first, file, last]);
    assert.equal(out.dropped, 0);
    assert.equal(out.parts[0], first);
    assert.equal(out.parts[1], file);
    assert.equal(out.parts[2], last);
  });

  test("keeps a file part in a clipped call", () => {
    const big = { type: "text", text: "z".repeat(12_000) };
    const file = { type: "file", uri: "file:///tmp/b.txt", name: "b.txt" };
    const parts: ShellPart[] = [big, file];
    const out = clipShellParts(parts);
    assert.equal(out.parts[1], file);
    assert.ok((out.parts[0].text ?? "").length <= 6_000);
    assert.ok(out.dropped > 0);
  });
});

describe("clipSubagentReports", () => {
  test("clips a real host report and keeps both tags", () => {
    const report = longReport();
    assert.ok(report.length > 2_000, `fixture is only ${report.length} chars`);
    const message = { role: "user", content: [{ type: "text", text: report }] };
    const out = clipSubagentReports([message]);
    assert.equal(out.clipped, 1);
    const text = out.messages[0].content[0].text ?? "";
    assert.ok(text.startsWith('<subagent sessionID="ses_abc123"'), "head lost the opening tag");
    assert.ok(text.endsWith("</subagent>"), "tail lost the closing tag");
    assert.ok(text.length <= 2_000, `got ${text.length}`);
    assert.match(text, REPORT_MARKER);
    assert.equal(out.messages[0].role, "user");
    const matched = text.match(REPORT_MARKER);
    assert.ok(matched !== null, "missing drop marker");
    assert.equal(Number(matched[1]), report.length - (text.length - matched[0].length));
  });

  test("leaves the original message and its text untouched", () => {
    const report = longReport();
    const part = { type: "text", text: report };
    const message = { role: "user", content: [part] };
    const input = [message];
    const out = clipSubagentReports(input);
    assert.equal(out.clipped, 1);
    assert.notEqual(out.messages, input);
    assert.notEqual(out.messages[0], message);
    assert.equal(message.content[0], part);
    assert.equal(part.text, report);
    assert.equal(message.content.length, 1);
  });

  test("is idempotent", () => {
    const message = { role: "user", content: [{ type: "text", text: longReport() }] };
    const once = clipSubagentReports([message]);
    const afterOnce = once.messages[0].content[0].text;
    const twice = clipSubagentReports(once.messages);
    assert.equal(twice.clipped, 0);
    assert.equal(twice.messages, once.messages);
    assert.equal(twice.messages[0].content[0].text, afterOnce);
  });

  test("leaves a user message quoting a bare <subagent> untouched", () => {
    const text = `<subagent>\n${padded(120, 30)}\n</subagent>`;
    const message = { role: "user", content: [{ type: "text", text }] };
    const out = clipSubagentReports([message]);
    assert.equal(out.clipped, 0);
    assert.equal(out.messages[0].content[0].text, text);
  });

  test("leaves a spoofed report from another role untouched", () => {
    const report = longReport();
    const assistant = { role: "assistant", content: [{ type: "text", text: report }] };
    const tool = { role: "tool", content: [{ type: "text", text: report }] };
    const out = clipSubagentReports([assistant, tool]);
    assert.equal(out.clipped, 0);
    assert.equal(out.messages[0].content[0].text, report);
    assert.equal(out.messages[1].content[0].text, report);
  });

  test("leaves a report whose opening tag has no state attribute untouched", () => {
    const text = `<subagent sessionID="ses_abc123">\n${padded(120, 30)}\n</subagent>`;
    const message = { role: "user", content: [{ type: "text", text }] };
    assert.equal(clipSubagentReports([message]).clipped, 0);
  });

  test("never clips a report that carries a real decision", () => {
    for (const decision of ["BLOCKED: need a decision on the cache key", "RISK: deletes the migration table", "NOT DONE: installer untouched"]) {
      const report = longReport(decision);
      const message = { role: "user", content: [{ type: "text", text: report }] };
      const out = clipSubagentReports([message]);
      assert.equal(out.clipped, 0, decision);
      assert.equal(out.messages[0].content[0].text, report, decision);
    }
  });

  test("never clips a report that carries a credential", () => {
    for (const secret of ["api_key = sk-live-abcdef123456", "-----BEGIN RSA PRIVATE KEY-----", "password: hunter2hunter2"]) {
      const report = longReport(secret);
      const message = { role: "user", content: [{ type: "text", text: report }] };
      assert.equal(clipSubagentReports([message]).clipped, 0, secret);
    }
  });

  test("still clips an empty decision", () => {
    const report = longReport();
    assert.ok(report.includes("BLOCKED: nothing"));
    assert.ok(report.includes("RISK: none"));
    const message = { role: "user", content: [{ type: "text", text: report }] };
    const out = clipSubagentReports([message]);
    assert.equal(out.clipped, 1);
    assert.ok((out.messages[0].content[0].text ?? "").length <= 2_000);
  });

  test("leaves a message with more than one text part untouched", () => {
    const report = longReport();
    const message = { role: "user", content: [{ type: "text", text: report }, { type: "text", text: "second part" }] };
    const out = clipSubagentReports([message]);
    assert.equal(out.clipped, 0);
    assert.equal(out.messages[0].content[0].text, report);
  });

  test("clips every tagged message and returns the count", () => {
    const first = { role: "user", content: [{ type: "text", text: longReport() }] };
    const second = { role: "user", content: [{ type: "text", text: longReport() }] };
    const plain = { role: "user", content: [{ type: "text", text: "short" }] };
    const out = clipSubagentReports([first, plain, second]);
    assert.equal(out.clipped, 2);
    assert.ok((out.messages[0].content[0].text ?? "").length <= 2_000);
    assert.ok((out.messages[2].content[0].text ?? "").length <= 2_000);
    assert.equal(out.messages[1], plain);
  });
});

describe("hardened shell sanitization", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const OVR = String.fromCharCode(0x202e);
  const ZWJ = String.fromCharCode(0x200d);

  test("strips OSC, CSI, bidi, and format controls and still holds the limit", () => {
    const head = `${ESC}]0;my title${BEL}first line\n`;
    const body = Array.from({ length: 400 }, (_, index) => `${ESC}[?25l${OVR}line ${index} ${ZWJ}${"y".repeat(30)}`);
    const text = `${head}${body.join("\n")}\nlast`;
    assert.ok(text.length > 6_000, `fixture is only ${text.length} chars`);
    const out = clipShellOutput(text).text;
    assert.ok(out.length <= 6_000, `got ${out.length}`);
    assert.ok(!out.includes(ESC), "escape survived");
    assert.ok(!out.includes(BEL), "BEL survived");
    assert.ok(!out.includes(OVR), "bidi override survived");
    assert.ok(!out.includes(ZWJ), "zero-width joiner survived");
    assert.ok(out.includes("first line"), "head lost");
    assert.ok(out.includes("last"), "tail lost");
    assert.match(out, SHELL_MARKER);
  });
});

describe("prototype-preserving report copies", () => {
  test("keeps the message prototype and own keys on the copy", () => {
    class FakeMessage {
      role = "user";
      content: { type: string; text: string }[];
      tag = "host-field";
      constructor(text: string) {
        this.content = [{ type: "text", text }];
      }
      summary(): string {
        return `${this.role}:${this.content.length}`;
      }
    }
    const full = longReport();
    const message = new FakeMessage(full);
    const out = clipSubagentReports([message]);
    assert.equal(out.clipped, 1);
    const copy = out.messages[0];
    assert.ok(copy instanceof FakeMessage);
    assert.equal(Object.getPrototypeOf(copy), Object.getPrototypeOf(message));
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(message).sort());
    assert.equal(copy.summary(), "user:1");
    assert.equal(copy.tag, "host-field");
    assert.ok((copy.content[0].text ?? "").length <= 2_000);
    assert.equal(message.content[0].text, full);
  });
});

describe("broadened decision and credential guards", () => {
  const ZWSP = String.fromCharCode(0x200b);

  test("still clips empty decisions", () => {
    for (const empty of ["BLOCKED: nothing", "RISK: none", "NOT DONE: nothing"]) {
      const report = subagentReport(`${padded(120, 30)}\n${empty}`);
      const message = { role: "user", content: [{ type: "text", text: report }] };
      const out = clipSubagentReports([message]);
      assert.equal(out.clipped, 1, empty);
      assert.ok((out.messages[0].content[0].text ?? "").length <= 2_000, empty);
    }
  });

  test("never clips indented, lowercase, or zero-width-obfuscated decisions", () => {
    const decisions = ["  RISK: deletes the table", "blocked: exfil", `BLOCK${ZWSP}ED: zero width`];
    for (const decision of decisions) {
      const report = longReport(decision);
      const message = { role: "user", content: [{ type: "text", text: report }] };
      const out = clipSubagentReports([message]);
      assert.equal(out.clipped, 0, decision);
      assert.equal(out.messages[0].content[0].text, report, decision);
    }
  });

  test("never clips a report that carries an AWS access key", () => {
    const report = longReport("deploy key AKIAIOSFODNN7EXAMPLE in output");
    const message = { role: "user", content: [{ type: "text", text: report }] };
    const out = clipSubagentReports([message]);
    assert.equal(out.clipped, 0);
    assert.equal(out.messages[0].content[0].text, report);
  });

  test("never clips a report that carries a GitHub token", () => {
    const report = longReport("token ghp_abcdefghijklmnopqrst in output");
    const message = { role: "user", content: [{ type: "text", text: report }] };
    const out = clipSubagentReports([message]);
    assert.equal(out.clipped, 0);
    assert.equal(out.messages[0].content[0].text, report);
  });

  test("never clips a report that carries a JWT", () => {
    const report = longReport("bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0fQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c here");
    const message = { role: "user", content: [{ type: "text", text: report }] };
    const out = clipSubagentReports([message]);
    assert.equal(out.clipped, 0);
    assert.equal(out.messages[0].content[0].text, report);
  });

  test("never clips a report that carries a Bearer token", () => {
    const report = longReport("auth Bearer abcdefgh12345678 here");
    const message = { role: "user", content: [{ type: "text", text: report }] };
    const out = clipSubagentReports([message]);
    assert.equal(out.clipped, 0);
    assert.equal(out.messages[0].content[0].text, report);
  });

  test("never clips a zero-width-obfuscated credential", () => {
    const report = longReport(`api${ZWSP}_key = sk-live-abcdef123456 here`);
    const message = { role: "user", content: [{ type: "text", text: report }] };
    const out = clipSubagentReports([message]);
    assert.equal(out.clipped, 0);
    assert.equal(out.messages[0].content[0].text, report);
  });
});
