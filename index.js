/**
 * ACP v2 — Agentic Context Pruning para OpenCode V2.
 *
 * Port del plugin de tuanhung303 (que solo funciona en OpenCode V1) sobre la
 * API de plugins de V2: `setup(ctx)`, `ctx.session.hook("context")`,
 * `ctx.tool.transform` y `ctx.tool.hook("execute.after")`.
 *
 * No tiene dependencias: usa solo node:crypto, node:fs y la API del host.
 */

import { resolveConfig } from "./lib/config.js"
import { callHash, pruneContext } from "./lib/prune.js"
import { SessionStore } from "./lib/registry.js"
import { createContextTool } from "./lib/tool.js"
import { HASH_CLOSE, HASH_OPEN } from "./lib/util.js"

export default {
  id: "mente.acp-v2",

  async setup(ctx) {
    const directory = ctx && ctx.location && ctx.location.directory
    const cfg = resolveConfig(directory, ctx && ctx.options)
    if (!cfg.enabled) {
      if (cfg.debug) console.log("[acp] desactivado por configuracion")
      return
    }

    const store = new SessionStore()
    let limits = new Map()
    let limitsAt = 0
    let passes = 0

    const log = (...args) => {
      if (cfg.debug) console.log("[acp]", ...args)
    }

    /** Ventana de contexto del modelo, cacheada 60 s. */
    const limitFor = async (model) => {
      if (Date.now() - limitsAt > 60000) {
        try {
          const list = await ctx.model.list()
          const next = new Map()
          for (const item of list || []) {
            const key = `${item.providerID}/${item.id}`
            const value = item && item.limit && item.limit.context
            if (value) next.set(key, Number(value))
          }
          limits = next
          limitsAt = Date.now()
        } catch (error) {
          log("no pude leer los modelos:", error && error.message)
        }
      }
      if (!model) return cfg.tokens.fallbackContextWindow
      return limits.get(`${model.providerID}/${model.id}`) || cfg.tokens.fallbackContextWindow
    }

    // 1. La herramienta que el agente puede invocar.
    try {
      await ctx.tool.transform((editor) => {
        editor.add(createContextTool(ctx, store, cfg))
      })
    } catch (error) {
      console.error("[acp] no pude registrar context_prune:", error && error.message)
    }

    // 2. El pase de podado, justo antes de cada peticion al modelo.
    await ctx.session.hook("context", async (event) => {
      try {
        const limit = await limitFor(event && event.model)
        const stats = pruneContext(event, store, cfg, limit)
        if (stats) {
          passes += 1
          if (stats.prunedCount > 0) {
            log(`podadas ${stats.prunedCount} salidas, ~${stats.savedTokens} tokens liberados`)
          }
          if (passes % 20 === 0) await store.persist(ctx, cfg.debug)
        }
      } catch (error) {
        console.error("[acp] error al podar:", error && error.message)
      }
    })

    // 3. Hash visible en cada salida de herramienta.
    if (cfg.visibleHashes) {
      try {
        await ctx.tool.hook("execute.after", (event) => {
          try {
            if (!event || event.status !== "completed" || !event.result) return
            if ((cfg.protectedTools || []).includes(event.tool)) return
            const content = event.result.content
            const flat =
              typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content
                      .map((part) => (part && part.type === "text" ? part.text : part && part.type === "file" ? part.uri : ""))
                      .filter(Boolean)
                      .join("\n")
                  : ""
            if (!flat || flat.includes(HASH_OPEN)) return
            const hash = callHash(event.tool, event.input, flat)
            const marker = `${HASH_OPEN}${hash}${HASH_CLOSE}`
            if (Array.isArray(content)) event.result.content = [...content, { type: "text", text: marker }]
            else event.result.content = `${flat}\n${marker}`
          } catch (error) {
            log("no pude marcar el hash:", error && error.message)
          }
        })
      } catch (error) {
        console.error("[acp] no pude registrar el marcador de hash:", error && error.message)
      }
    }

    // 4. Comando /acp con el estado actual.
    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "acp",
          description: "Estado del podado de contexto (ACP): tokens liberados y presion.",
          execute: async ({ sessionID }) => {
            const state = store.session(sessionID)
            const last = state.last
            const stored = (await ctx.storage.get("stats").catch(() => undefined)) || {}
            const lines = [
              "ACP — podado de contexto",
              `  Sesion: ${state.stats.prunedCount} salidas podadas, ~${state.stats.savedTokens} tokens liberados`,
              `  Historico: ${stored.prunedCount || 0} salidas, ~${stored.savedTokens || 0} tokens`,
              last
                ? `  Presion: ${Math.round(last.pressure * 100)}% de ${Math.round(last.window / 1000)}k tokens (${last.toolResults} salidas)`
                : "  Presion: sin datos todavia",
            ]
            await ctx.session.synthetic({ sessionID, text: lines.join("\n") })
          },
        })
      })
    } catch (error) {
      log("no pude registrar el comando /acp:", error && error.message)
    }

    // 5. Persistir el acumulado cuando la sesion queda inactiva.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event && event.type === "session.idle") await store.persist(ctx, cfg.debug)
        }
      } catch {
        /* el stream se cierra al descargar el plugin */
      }
    })()

    log(`cargado en ${directory || "?"} (preset ${cfg.preset})`)

    return async () => {
      controller.abort()
      await store.persist(ctx, cfg.debug)
    }
  },
}
