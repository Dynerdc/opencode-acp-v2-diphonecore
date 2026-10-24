/**
 * Configuracion: valores por defecto, presets y lectura de `acp.jsonc`.
 *
 * Precedencia (de menor a mayor):
 *   1. DEFAULT_CONFIG
 *   2. <config global>/acp.jsonc
 *   3. <proyecto>/.opencode/acp.jsonc
 *   4. opciones del plugin en opencode.json(c)
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_PROTECTED_TOOLS = [
  "context_prune",
  "task",
  "todowrite",
  "todoread",
  "todo",
  "batch",
  "write",
  "edit",
  "apply_patch",
]

export const DEFAULT_CONFIG = {
  enabled: true,
  debug: false,
  visibleHashes: true,
  preset: "balanced",
  protectedTools: [...DEFAULT_PROTECTED_TOOLS],
  protectedFilePatterns: [
    "**/.env",
    "**/.env.*",
    "**/credentials.json",
    "**/secrets.json",
    "**/*.pem",
    "**/*.key",
    "**/package.json",
    "**/tsconfig.json",
    "**/pyproject.toml",
    "**/Cargo.toml",
  ],
  strategies: {
    identicalCalls: true,
    oneFileOneView: true,
    stateQueries: true,
    sourceUrls: true,
    todos: true,
    snapshots: true,
    retryAttempts: true,
    pruneToolInputs: true,
    truncateOldErrors: false,
    purgeErrors: { enabled: false, turns: 4 },
  },
  protection: {
    recentTurns: 2,
    keepLastResults: 4,
    maxStubTokens: 4000,
  },
  tokens: {
    warningThreshold: 0.7,
    criticalThreshold: 0.85,
    fallbackContextWindow: 200000,
  },
}

const PRESETS = {
  compact: {
    strategies: { truncateOldErrors: true, purgeErrors: { enabled: true, turns: 4 } },
    protection: { recentTurns: 1, keepLastResults: 2 },
  },
  balanced: {},
  verbose: {
    strategies: {
      identicalCalls: false,
      oneFileOneView: false,
      stateQueries: false,
      sourceUrls: false,
      todos: false,
      snapshots: false,
      retryAttempts: false,
      pruneToolInputs: false,
      truncateOldErrors: false,
      purgeErrors: { enabled: false, turns: 6 },
    },
    protection: { recentTurns: 3, keepLastResults: 8 },
  },
}

/** Quita comentarios de linea y de bloque de un JSONC sin romper las cadenas. */
export function parseJsonc(text) {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (ch === "\n") {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += text[i + 1] ?? ""
        i++
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      inLine = true
      i++
      continue
    }
    if (ch === "/" && next === "*") {
      inBlock = true
      i++
      continue
    }
    out += ch
  }
  // comillas simples -> dobles y comas colgantes
  const cleaned = out.replace(/,\s*([}\]])/g, "$1")
  return JSON.parse(cleaned)
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return extra === undefined ? base : extra
  const result = Array.isArray(base) ? [...base] : { ...(base || {}) }
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base && typeof base[key] === "object") {
      result[key] = deepMerge(base[key], value)
    } else if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

export function globalConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return join(xdg, "opencode")
  return join(homedir(), ".config", "opencode")
}

function readJsonc(path) {
  try {
    if (!existsSync(path)) return undefined
    return parseJsonc(readFileSync(path, "utf8"))
  } catch (error) {
    console.error(`[acp] no pude leer ${path}: ${error && error.message}`)
    return undefined
  }
}

export function resolveConfig(projectDir, options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    strategies: { ...DEFAULT_CONFIG.strategies, purgeErrors: { ...DEFAULT_CONFIG.strategies.purgeErrors } },
    protection: { ...DEFAULT_CONFIG.protection },
    tokens: { ...DEFAULT_CONFIG.tokens },
    protectedTools: [...DEFAULT_CONFIG.protectedTools],
    protectedFilePatterns: [...DEFAULT_CONFIG.protectedFilePatterns],
  }

  const candidates = [join(globalConfigDir(), "acp.jsonc")]
  if (projectDir) candidates.push(join(projectDir, ".opencode", "acp.jsonc"))
  for (const path of candidates) {
    const data = readJsonc(path)
    if (data) Object.assign(config, deepMerge(config, data))
  }
  if (options && Object.keys(options).length > 0) Object.assign(config, deepMerge(config, options))

  const preset = PRESETS[config.preset]
  if (preset) Object.assign(config, deepMerge(config, preset))

  config.protectedTools = Array.isArray(config.protectedTools) ? config.protectedTools : []
  config.protectedFilePatterns = Array.isArray(config.protectedFilePatterns)
    ? config.protectedFilePatterns
    : []
  return config
}
