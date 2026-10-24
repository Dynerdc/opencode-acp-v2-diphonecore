/**
 * Herramienta `context_prune`: la interfaz que usa el agente para podar a mano.
 * Acciones: list | discard | distill | replace | stats | reset
 */

import { truncate } from "./util.js"

const SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "discard", "distill", "replace", "stats", "reset"],
      description:
        "list: ver que se puede podar (con hash). discard: borrar salidas. distill: resumirlas. replace: reemplazar un bloque literal. stats: estadisticas. reset: deshacer podas manuales pendientes.",
    },
    targets: {
      type: "array",
      description:
        "Para discard: [[\"hash\"]]. Para distill: [[\"hash\", \"resumen\"]]. Para replace: [[\"inicio\", \"fin\", \"reemplazo\"]].",
      items: { type: "array", items: { type: "string" } },
    },
    reason: { type: "string", description: "Motivo opcional, para el registro." },
  },
  required: ["action"],
  additionalProperties: false,
}

const DESCRIPTION = `Gestiona el contexto de esta sesion: elimina salidas de herramientas que ya no aportan y libera tokens.

Cada salida de herramienta lleva un hash visible: <tool_hash>1a2b3c</tool_hash>.
Usa ese hash en targets.

- list: muestra las salidas podables con su hash, herramienta y tamano.
- discard: elimina las salidas indicadas. targets: [["hash"]]
- distill: reemplaza la salida por un resumen tuyo. targets: [["hash","resumen corto"]]
- replace: reemplaza un bloque de texto literal. targets: [["inicio","fin","[reemplazo]"]]. El bloque debe medir 30+ caracteres, uno de los extremos 15+ y aparecer una sola vez.
- stats: cuanto se ha podado en esta sesion y en total.
- reset: olvida las podas manuales pendientes.

Los cambios se aplican en la siguiente peticion al modelo. El historial guardado no se modifica.
El plugin ya poda solo: llamadas duplicadas, operaciones superadas sobre el mismo archivo, consultas de estado, URLs repetidas, todos y snapshots. Usa esta herramienta para el resto.`

function formatEntry(entry) {
  const flags = [entry.error ? "error" : "", entry.pruned ? "podado" : ""].filter(Boolean).join(",")
  const tail = flags ? ` (${flags})` : ""
  return `${entry.hash}  ${entry.name.padEnd(16).slice(0, 16)}  ~${String(entry.tokens).padStart(5)} tok  ${entry.preview}${tail}`
}

function describePressure(last, cfg) {
  if (!last) return "presion de contexto: sin datos"
  const pct = Math.round(last.pressure * 100)
  const warn = Math.round((cfg.tokens.warningThreshold || 0.7) * 100)
  const crit = Math.round((cfg.tokens.criticalThreshold || 0.85) * 100)
  const level = pct >= crit ? "critica" : pct >= warn ? "alta" : "normal"
  return `presion de contexto: ${pct}% de ${Math.round(last.window / 1000)}k (${level})`
}

export function createContextTool(ctx, store, cfg) {
  return {
    name: "context_prune",
    description: DESCRIPTION,
    input: SCHEMA,
    execute: async (input, context) => {
      const action = String((input && input.action) || "list")
      const state = store.session(context && context.sessionID)
      const targets = Array.isArray(input && input.targets) ? input.targets : []

      if (action === "list") {
        const entries = [...state.entries.values()].filter((e) => !["manual", "si"].includes(e.pruned || ""))
        entries.sort((a, b) => b.tokens - a.tokens)
        const prunable = entries.reduce((sum, e) => sum + e.tokens, 0)
        const lines = entries.slice(0, 25).map(formatEntry)
        const head = `Podables: ${entries.length} salidas, ~${prunable} tokens. ${describePressure(state.last, cfg)}`
        const body = lines.length ? lines.join("\n") : "(no hay salidas podables en este momento)"
        const note = entries.length > 25 ? `\n... y ${entries.length - 25} mas.` : ""
        return { content: `${head}\n${body}${note}` }
      }

      if (action === "discard" || action === "distill") {
        if (!targets.length) return { content: `Falta targets. Ejemplo: [["a1b2c3"]]` }
        const done = []
        const missing = []
        for (const target of targets) {
          const hash = String((target && target[0]) || "").trim()
          if (!hash) continue
          const callID = state.hashes.get(hash)
          if (!callID) {
            missing.push(hash)
            continue
          }
          if (action === "distill") {
            const summary = String((target && target[1]) || "").trim()
            if (!summary) {
              missing.push(hash)
              continue
            }
            state.manual.set(callID, { mode: "distill", text: summary })
          } else {
            state.manual.set(callID, { mode: "discard" })
          }
          const entry = state.entries.get(callID)
          done.push(`${hash}${entry ? ` (${entry.name})` : ""}`)
        }
        const parts = []
        if (done.length) parts.push(`${action === "distill" ? "Diluyendo" : "Descartando"}: ${done.join(", ")}`)
        if (missing.length) parts.push(`No encontrados: ${missing.join(", ")}. Usa action:"list" para ver hashes validos.`)
        parts.push("Se aplica en la siguiente peticion al modelo.")
        return { content: parts.join("\n") }
      }

      if (action === "replace") {
        if (!targets.length) return { content: `Falta targets. Ejemplo: [["Inicio del bloque","Fin del bloque.","[podado]"]]` }
        let accepted = 0
        const rejected = []
        for (const target of targets) {
          const start = String((target && target[0]) || "")
          const end = String((target && target[1]) || "")
          const replacement = String((target && target[2]) || "[podado]")
          if (!start || !end || (start.length <= 15 && end.length <= 15)) {
            rejected.push(truncate(start || end, 40))
            continue
          }
          state.patterns.push([start, end, replacement])
          accepted += 1
        }
        const parts = [`Reemplazos en cola: ${accepted}.`]
        if (rejected.length) parts.push(`Rechazados (marcadores muy cortos): ${rejected.join(", ")}`)
        parts.push("Se aplican una sola vez en la siguiente peticion.")
        return { content: parts.join("\n") }
      }

      if (action === "reset") {
        const count = state.manual.size
        state.manual.clear()
        state.patterns = []
        return { content: `Podas manuales pendientes borradas: ${count}.` }
      }

      if (action === "stats") {
        const s = state.stats
        const stored = (await ctx.storage.get("stats").catch(() => undefined)) || {}
        const lines = [
          `Sesion: ${s.prunedCount} salidas podadas, ~${s.savedTokens} tokens liberados.`,
          s.byReason && Object.keys(s.byReason).length
            ? `  Por motivo: ${Object.entries(s.byReason).map(([k, v]) => `${k}=${v}`).join(", ")}`
            : "",
          `Historico: ${stored.prunedCount || 0} salidas, ~${stored.savedTokens || 0} tokens.`,
          describePressure(state.last, cfg),
          state.last ? `  Ultimo pase: ${state.last.toolResults} salidas, ~${state.last.tokensBefore} -> ~${state.last.tokensAfter} tokens.` : "",
        ].filter(Boolean)
        return { content: lines.join("\n") }
      }

      return { content: `Accion desconocida: ${action}. Usa list, discard, distill, replace, stats o reset.` }
    },
  }
}
