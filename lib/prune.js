/**
 * Nucleo del port: recorre los mensajes de un request, detecta contexto
 * obsoleto y lo reemplaza por stubs. Nunca borra mensajes ni rompe el par
 * tool-call / tool-result: solo reescribe el contenido del resultado.
 */

import {
  DISTILL_PREFIX,
  STUB_PREFIX,
  estimateTokens,
  isProtectedPath,
  isStub,
  resultText,
  shortHash,
  stableStringify,
  stripHashMarker,
  truncate,
} from "./util.js"

const REASON = {
  identical: "llamada duplicada identica",
  file: "operacion posterior sobre el mismo archivo",
  state: "estado ya actualizado por una consulta posterior",
  url: "misma URL consultada otra vez",
  todo: "estado de tareas ya reemplazado",
  snapshot: "snapshot posterior del mismo archivo",
  retry: "reintento exitoso de la misma llamada",
  error: "error antiguo ya resuelto",
  manual: "solicitado por context_prune",
}

const PATH_KEYS = ["filePath", "file_path", "path", "filename", "fileName", "target", "uri"]
const VERBOSE_KEY = /^(content|newString|oldString|old_string|new_string|text|patch|body|diff|replacement)$/i

const STATE_QUERY_NAMES = new Set([
  "ls",
  "dir",
  "pwd",
  "find",
  "tree",
  "glob",
  "grep",
  "search",
  "vcs",
  "git",
  "status",
])

const SHELL_NAMES = new Set(["bash", "shell", "sh", "pwsh", "powershell", "exec", "run", "command", "terminal"])

const STATE_COMMAND = /^\s*(ls|dir|pwd|find|tree|rg|grep|git\s+(status|branch|log|diff\s+--stat|show\s+--stat))\b/i

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
}

function pathFromInput(input) {
  const obj = asObject(input)
  if (!obj) return undefined
  for (const key of PATH_KEYS) {
    const value = obj[key]
    if (typeof value === "string" && value.length > 0 && value.length < 400) return value.replaceAll("\\", "/")
  }
  return undefined
}

function urlFromInput(input) {
  const obj = asObject(input)
  if (!obj) return undefined
  for (const key of ["url", "uri", "href"]) {
    const value = obj[key]
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value
  }
  return undefined
}

function commandFromInput(input) {
  const obj = asObject(input)
  if (!obj) return undefined
  for (const key of ["command", "cmd", "script"]) {
    const value = obj[key]
    if (typeof value === "string") return value
    if (Array.isArray(value)) return value.join(" ")
  }
  return undefined
}

function isShellStateQuery(name, input) {
  if (!SHELL_NAMES.has(name)) return false
  const command = commandFromInput(input)
  return typeof command === "string" && STATE_COMMAND.test(command)
}

function stubText(name, reason, detail) {
  const suffix = detail ? `: ${detail}` : ""
  return `${STUB_PREFIX} ${name}() output: ${reason}${suffix}]`
}

function readString(value) {
  return typeof value === "string" ? value : ""
}

/**
 * Calcula el hash visible de una llamada. Es estable porque depende solo del
 * nombre, los argumentos y el texto del resultado original.
 */
export function callHash(name, input, text) {
  return shortHash(`${name}\u0000${stableStringify(input)}\u0000${stripHashMarker(text)}`)
}

function shouldStripInput(input) {
  const obj = asObject(input)
  if (!obj) return false
  return Object.entries(obj).some(([key, value]) => VERBOSE_KEY.test(key) && typeof value === "string" && value.length > 400)
}

function stripVerboseInput(part) {
  const obj = asObject(part.input)
  if (!obj) return 0
  let saved = 0
  const copy = { ...obj }
  for (const [key, value] of Object.entries(copy)) {
    if (VERBOSE_KEY.test(key) && typeof value === "string" && value.length > 400) {
      saved += value.length - 8
      copy[key] = "[pruned]"
    }
  }
  if (saved > 0) part.input = copy
  return saved
}

/**
 * Aplica los reemplazos literales pendientes y devuelve cuantos aplico.
 * Reglas heredadas del original: el bloque debe medir >= 30 caracteres,
 * al menos uno de los extremos > 15 y debe existir una sola coincidencia.
 */
export function applyPatterns(messages, patterns) {
  if (!patterns || patterns.length === 0) return { applied: 0, saved: 0 }
  let applied = 0
  let saved = 0
  for (const pattern of patterns) {
    const [start, end, replacement] = pattern
    if (!start || !end) continue
    for (const msg of messages) {
      if (!msg || !Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        const text = part && part.type === "text" ? readString(part.text) : part && part.type === "tool-result" ? resultText(part.result) : ""
        if (!text || !text.includes(start)) continue
        const from = text.indexOf(start)
        const to = text.indexOf(end, from + start.length)
        if (to < 0) continue
        const block = text.slice(from, to + end.length)
        if (block.length < 30) continue
        if (start.length <= 15 && end.length <= 15) continue
        if (text.indexOf(start, from + 1) !== -1) continue
        const next = text.slice(0, from) + replacement + text.slice(to + end.length)
        const delta = text.length - next.length
        if (part.type === "text") part.text = next
        else part.result = { type: "text", value: next }
        applied++
        saved += Math.max(0, delta)
        break
      }
    }
  }
  return { applied, saved }
}

/**
 * Poda el contexto de un request. Devuelve estadisticas del pase.
 * @param {{sessionID:string, messages:any[], model?:any}} event
 * @param {import("./registry.js").SessionStore} store
 * @param {any} cfg
 * @param {number} [limit] ventana de contexto del modelo en tokens
 */
export function pruneContext(event, store, cfg, limit) {
  const messages = Array.isArray(event && event.messages) ? event.messages : []
  if (messages.length === 0) return null

  const state = store.session(event.sessionID)
  state.pass += 1

  const calls = new Map()
  const results = []
  let turn = 0
  let conversationChars = 0

  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m]
    if (!msg || !Array.isArray(msg.content)) continue
    if (msg.role === "user") turn += 1
    for (let p = 0; p < msg.content.length; p++) {
      const part = msg.content[p]
      if (!part || typeof part !== "object") continue
      if (part.type === "text") {
        conversationChars += readString(part.text).length
      } else if (part.type === "tool-call") {
        calls.set(part.id, { part, index: results.length, turn })
        try {
          conversationChars += JSON.stringify(part.input || {}).length
        } catch {
          /* input no serializable: no cuenta */
        }
      } else if (part.type === "tool-result") {
        const text = stripHashMarker(resultText(part.result))
        conversationChars += text.length
        results.push({
          part,
          id: part.id,
          name: readString(part.name),
          text,
          error: !!(part.result && part.result.type === "error"),
          turn,
          position: results.length,
        })
      }
    }
  }

  // La presion se mide sobre toda la conversacion, no solo sobre las salidas.
  const tokensBefore = Math.ceil(conversationChars / 4)

  const lastTurn = turn
  const protectedFrom = Math.max(1, lastTurn - Math.max(0, cfg.protection.recentTurns) + 1)
  const keepTail = Math.max(0, cfg.protection.keepLastResults)
  const protectedTools = new Set((cfg.protectedTools || []).map((t) => String(t).toLowerCase()))

  const protectedResult = (item) => {
    if (item.turn >= protectedFrom && item.turn > 0) return true
    if (item.position >= results.length - keepTail) return true
    if (protectedTools.has(item.name.toLowerCase())) return true
    return false
  }

  const groups = new Map()
  const addGroup = (key, item) => {
    if (!key) return
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }

  for (const item of results) {
    if (isStub(item.text)) continue
    const call = calls.get(item.id)
    const input = call ? call.part.input : undefined
    const strategies = cfg.strategies || {}

    if (strategies.identicalCalls) addGroup(`identical:${item.name}:${stableStringify(input)}`, item)
    const path = pathFromInput(input)
    if (strategies.oneFileOneView && path) addGroup(`file:${path}`, item)
    const url = urlFromInput(input)
    if (strategies.sourceUrls && url) addGroup(`url:${url}`, item)
    if (strategies.stateQueries && (STATE_QUERY_NAMES.has(item.name.toLowerCase()) || isShellStateQuery(item.name.toLowerCase(), input))) {
      addGroup(`state:${item.name}:${commandFromInput(input) || ""}`, item)
    }
    if (strategies.todos && /todo/i.test(item.name)) addGroup("todo", item)
    if (strategies.snapshots && /snapshot|checkpoint|revert/i.test(item.name)) addGroup(`snapshot:${path || ""}`, item)
    if (item.name === "context_prune") addGroup("context_prune", item)
  }

  let prunedCount = 0
  let savedChars = 0
  const byReason = {}

  const stub = (item, reason, detail, options = {}) => {
    if (!options.force && protectedTools.has(item.name.toLowerCase())) return false
    if (isStub(item.text)) return false
    const text = `${stubText(item.name, reason, detail)}`
    const delta = item.text.length - text.length
    if (delta <= 0) return false
    try {
      item.part.result = { type: "text", value: text }
    } catch {
      return false
    }
    item.text = text
    item.pruned = reason
    prunedCount += 1
    savedChars += delta
    byReason[reason] = (byReason[reason] || 0) + 1
    return true
  }

  // 1. Estrategias automaticas: de cada grupo sobrevive la ultima llamada.
  for (const [key, items] of groups) {
    if (items.length < 2) continue
    const keep = items[items.length - 1]
    const reason =
      key.startsWith("identical:")
        ? REASON.identical
        : key.startsWith("file:")
          ? REASON.file
          : key.startsWith("url:")
            ? REASON.url
            : key.startsWith("state:")
              ? REASON.state
              : key.startsWith("todo")
                ? REASON.todo
                : key.startsWith("snapshot:")
                  ? REASON.snapshot
                  : REASON.state
    for (const item of items) {
      if (item === keep) continue
      if (protectedResult(item)) continue
      stub(item, reason)
      if (cfg.strategies.pruneToolInputs) {
        const call = calls.get(item.id)
        if (call && shouldStripInput(call.part.input)) savedChars += stripVerboseInput(call.part)
      }
    }
  }

  // 2. Reintentos: si la misma llamada fallo antes y luego funciono, el error sobra.
  if (cfg.strategies.retryAttempts) {
    const successKeys = new Set()
    for (const item of results) {
      if (item.error || isStub(item.text)) continue
      successKeys.add(`${item.name}:${stableStringify(calls.get(item.id)?.part?.input)}`)
    }
    for (const item of results) {
      if (!item.error || isStub(item.text)) continue
      const key = `${item.name}:${stableStringify(calls.get(item.id)?.part?.input)}`
      if (!successKeys.has(key)) continue
      if (protectedResult(item)) continue
      stub(item, REASON.retry)
    }
  }

  // 3. Errores viejos.
  const purge = (cfg.strategies && cfg.strategies.purgeErrors) || {}
  if (purge.enabled || cfg.strategies.truncateOldErrors) {
    const age = Number(purge.turns) || 4
    for (const item of results) {
      if (!item.error || isStub(item.text)) continue
      if (lastTurn - item.turn < age) continue
      if (protectedResult(item)) continue
      stub(item, REASON.error)
    }
  }

  // 4. Peticiones explicitas del agente (discard / distill).
  for (const [callID, manual] of state.manual) {
    const item = results.find((r) => r.id === callID)
    if (!item || isStub(item.text)) continue
    if (manual.mode === "distill") {
      const text = `${DISTILL_PREFIX} ${item.name}() output: ${truncate(manual.text, 240)}]`
      const delta = item.text.length - text.length
      if (delta > 0) {
        try {
          item.part.result = { type: "text", value: text }
          item.text = text
          item.pruned = "manual"
          prunedCount += 1
          savedChars += delta
          byReason[REASON.manual] = (byReason[REASON.manual] || 0) + 1
        } catch {
          /* si el mensaje esta congelado, se ignora este pase */
        }
      }
    } else {
      stub(item, REASON.manual, undefined, { force: true })
    }
  }
  for (const callID of state.manual.keys()) {
    if (!results.some((r) => r.id === callID)) state.manual.delete(callID)
  }

  // 5. Reemplazos por patron (se aplican una sola vez).
  if (state.patterns.length) {
    const { applied, saved } = applyPatterns(messages, state.patterns)
    if (applied > 0) {
      savedChars += saved
      state.stats.patternReplaces = (state.stats.patternReplaces || 0) + applied
      state.patterns = []
    }
  }

  // Registro visible para el agente (hash -> llamada).
  for (const item of results) {
    const call = calls.get(item.id)
    const input = call ? call.part.input : undefined
    const previous = state.entries.get(item.id)
    const hash = previous ? previous.hash : callHash(item.name, input, item.text)
    const entry = {
      hash,
      callID: item.id,
      name: item.name,
      tokens: estimateTokens(item.text),
      preview: truncate(item.text, 90),
      pruned: isStub(item.text) ? "si" : undefined,
      reason: item.pruned,
      error: item.error,
    }
    state.entries.set(item.id, entry)
    state.hashes.set(hash, item.id)
  }

  // Limpia el registro de llamadas que ya no estan en la conversacion.
  const alive = new Set(results.map((item) => item.id))
  for (const callID of state.entries.keys()) {
    if (!alive.has(callID)) {
      const entry = state.entries.get(callID)
      if (entry && state.hashes.get(entry.hash) === callID) state.hashes.delete(entry.hash)
      state.entries.delete(callID)
    }
  }

  const savedTokens = Math.round(savedChars / 4)
  state.stats.prunedCount += prunedCount
  state.stats.savedTokens += savedTokens
  for (const [reason, count] of Object.entries(byReason)) {
    state.stats.byReason[reason] = (state.stats.byReason[reason] || 0) + count
  }

  const window = Number(limit) > 0 ? Number(limit) : Number(cfg.tokens.fallbackContextWindow) || 200000
  state.last = {
    messageCount: messages.length,
    toolResults: results.length,
    tokensBefore,
    tokensAfter: Math.max(0, tokensBefore - savedTokens),
    window,
    pressure: Math.max(0, tokensBefore - savedTokens) / window,
    at: Date.now(),
  }

  return {
    prunedCount,
    savedTokens,
    tokensBefore,
    tokensAfter: state.last.tokensAfter,
    window,
    pressure: state.last.pressure,
  }
}

export { REASON, stubText }
