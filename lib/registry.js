/**
 * Estado por sesion: que se podo, que pidio podar el agente y estadisticas.
 * Todo vive en memoria; el acumulado historico se guarda con `ctx.storage`.
 */

const EMPTY_STATS = () => ({
  prunedCount: 0,
  savedTokens: 0,
  byReason: {},
  lastSavedAt: 0,
})

export class SessionStore {
  constructor() {
    this.sessions = new Map()
  }

  session(sessionID) {
    const key = sessionID || "global"
    let state = this.sessions.get(key)
    if (!state) {
      state = {
        id: key,
        /** callID -> { manual: {mode, text} } */
        manual: new Map(),
        /** callID -> entrada visible para el modelo */
        entries: new Map(),
        /** hash -> callID */
        hashes: new Map(),
        /** patrones de reemplazo literales pendientes */
        patterns: [],
        stats: EMPTY_STATS(),
        last: null,
        pass: 0,
      }
      this.sessions.set(key, state)
    }
    return state
  }

  forget(sessionID) {
    this.sessions.delete(sessionID)
  }

  pruneEmptySessions(keep) {
    for (const id of this.sessions.keys()) {
      if (!keep || !keep.has(id)) this.sessions.delete(id)
    }
  }

  /** Guarda el acumulado de todas las sesiones en el storage del plugin. */
  async persist(ctx, debug) {
    if (!this.sessions.size) return
    try {
      const stored = (await ctx.storage.get("stats")) || {}
      const total = {
        prunedCount: Number(stored.prunedCount) || 0,
        savedTokens: Number(stored.savedTokens) || 0,
        byReason: stored.byReason && typeof stored.byReason === "object" ? { ...stored.byReason } : {},
        sessions: Number(stored.sessions) || 0,
        updatedAt: Date.now(),
      }
      for (const state of this.sessions.values()) {
        total.prunedCount += state.stats.prunedCount
        total.savedTokens += state.stats.savedTokens
        total.sessions += 1
        for (const [reason, count] of Object.entries(state.stats.byReason)) {
          total.byReason[reason] = (total.byReason[reason] || 0) + count
        }
        state.stats = EMPTY_STATS()
      }
      await ctx.storage.set("stats", total)
    } catch (error) {
      if (debug) console.error(`[acp] no pude guardar estadisticas: ${error && error.message}`)
    }
  }
}
