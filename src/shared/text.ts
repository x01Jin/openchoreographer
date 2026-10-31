

export function sanitizeForContext(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, "").replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
}

export function displayWidth(value: string): number {
  let width = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0xfe0f || code === 0x200d) continue
    if (
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x1dc0 && code <= 0x1dff) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe20 && code <= 0xfe2f)
    ) {
      continue
    }
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x2600 && code <= 0x27bf) ||
      (code >= 0x1f000 && code <= 0x1f02f)
    ) {
      width += 2
    } else {
      width += 1
    }
  }
  return width
}
