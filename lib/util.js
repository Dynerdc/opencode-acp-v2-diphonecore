/**
 * Utilidades sin dependencias: hashing estable, estimacion de tokens y globs.
 */

import { createHash } from "node:crypto"

/** Marca que llevan los stubs para poder detectarlos sin heuristica fragil. */
export const STUB_PREFIX = "[ACP pruned"
export const DISTILL_PREFIX = "[ACP distilled"
export const HASH_OPEN = "<tool_hash>"
export const HASH_CLOSE = "</tool_hash>"

/**
 * JSON.stringify con claves ordenadas y profundidad limitada.
 * Sirve para que la misma llamada produzca siempre el mismo hash.
 */
export function stableStringify(value, depth = 0) {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  const t = typeof value
  if (t === "string") return JSON.stringify(value)
  if (t === "number" || t === "boolean" || t === "bigint") return String(value)
  if (t === "function" || t === "symbol") return "null"
  if (depth > 6) return '"[deep]"'
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v, depth + 1)).join(",") + "]"
  }
  const keys = Object.keys(value).sort()
  const body = keys
    .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k], depth + 1))
    .join(",")
  return "{" + body + "}"
}

export function sha1(text) {
  return createHash("sha1").update(text, "utf8").digest("hex")
}

/** Hash corto y estable de seis caracteres, el que ve el modelo. */
export function shortHash(text) {
  return sha1(text).slice(0, 6)
}

/** Estimacion de tokens: ~4 caracteres por token en texto latino y codigo. */
export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / 4)
}

export function textOf(value) {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Extrae el texto plano del `result` de una ToolResultPart de V2. */
export function resultText(result) {
  if (!result) return ""
  const { type, value } = result
  if (type === "content") {
    if (Array.isArray(value)) {
      return value
        .map((part) => (part && part.type === "text" ? part.text : part && part.uri ? part.uri : ""))
        .filter(Boolean)
        .join("\n")
    }
    return textOf(value)
  }
  return textOf(value)
}

/** Quita el marcador `<tool_hash>` para que el hash no dependa de si mismo. */
export function stripHashMarker(text) {
  if (!text || !text.includes(HASH_OPEN)) return text || ""
  return String(text)
    .replace(new RegExp(`\\n?${HASH_OPEN}[0-9a-f]+${HASH_CLOSE}`, "g"), "")
    .trimEnd()
}

export function isStub(text) {
  if (!text) return false
  const head = String(text).trimStart()
  return head.startsWith(STUB_PREFIX) || head.startsWith(DISTILL_PREFIX)
}

export function truncate(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim()
  return value.length <= max ? value : value.slice(0, max - 1) + "\u2026"
}

function escapeRegExpChar(ch) {
  return /[\\^$+{}()|[\].*?]/.test(ch) ? `\\${ch}` : ch
}

/** Glob basico con `**`, `*` y `?`, igual que el original. */
export function matchesGlob(inputPath, pattern) {
  if (!pattern || !inputPath) return false
  const input = String(inputPath).replaceAll("\\", "/")
  const pat = String(pattern).replaceAll("\\", "/")
  let regex = "^"
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        if (pat[i + 2] === "/") {
          regex += "(?:.*/)?"
          i += 2
          continue
        }
        regex += ".*"
        i += 1
        continue
      }
      regex += "[^/]*"
      continue
    }
    if (ch === "?") {
      regex += "[^/]"
      continue
    }
    regex += escapeRegExpChar(ch)
  }
  regex += "$"
  try {
    return new RegExp(regex).test(input)
  } catch {
    return false
  }
}

export function isProtectedPath(filePath, patterns) {
  if (!filePath || !Array.isArray(patterns) || patterns.length === 0) return false
  return patterns.some((pattern) => matchesGlob(filePath, pattern))
}
