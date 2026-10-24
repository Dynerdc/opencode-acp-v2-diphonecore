import assert from "node:assert/strict"
import test from "node:test"

import { DEFAULT_CONFIG } from "../lib/config.js"
import { pruneContext } from "../lib/prune.js"
import { SessionStore } from "../lib/registry.js"
import { createContextTool } from "../lib/tool.js"
import { isStub } from "../lib/util.js"

const cfgWith = (patch = {}) => ({
  ...DEFAULT_CONFIG,
  strategies: { ...DEFAULT_CONFIG.strategies, ...(patch.strategies || {}) },
  protection: { ...DEFAULT_CONFIG.protection, keepLastResults: 0, ...(patch.protection || {}) },
  tokens: { ...DEFAULT_CONFIG.tokens },
})

const user = (text = "sigue") => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (...parts) => ({ role: "assistant", content: parts })
const toolMsg = (...parts) => ({ role: "tool", content: parts })
const call = (id, name, input) => ({ type: "tool-call", id, name, input })
const result = (id, name, value) => ({ type: "tool-result", id, name, result: { type: "text", value } })

const big = (tag, n = 2000) => `${tag} ${"x".repeat(n)}`

function duplicateMessages() {
  return [
    user("uno"),
    assistant(call("c1", "read", { filePath: "src/a.ts" })),
    toolMsg(result("c1", "read", big("PRIMERA"))),
    user("dos"),
    assistant(call("c2", "read", { filePath: "src/a.ts" })),
    toolMsg(result("c2", "read", big("SEGUNDA"))),
    user("tres"),
    assistant({ type: "text", text: "listo" }),
    user("cuatro"),
    assistant({ type: "text", text: "nada mas" }),
  ]
}

test("la llamada identica anterior se poda y la ultima sobrevive", () => {
  const store = new SessionStore()
  const cfg = cfgWith()
  const messages = duplicateMessages()
  const stats = pruneContext({ sessionID: "s1", messages }, store, cfg, 200000)

  assert.ok(stats.prunedCount >= 1)
  const [first] = messages[2].content
  const [second] = messages[5].content
  assert.equal(isStub(first.result.value), true)
  assert.equal(isStub(second.result.value), false)
  assert.match(first.result.value, /read\(\) output/)
  // el par tool-call / tool-result sigue intacto
  assert.equal(first.type, "tool-result")
  assert.equal(first.id, "c1")
  assert.equal(messages[1].content[0].id, "c1")
  assert.ok(stats.savedTokens > 0)
})

test("los turnos recientes quedan protegidos", () => {
  const store = new SessionStore()
  const cfg = cfgWith({ protection: { recentTurns: 2 } })
  const messages = [
    user("uno"),
    assistant(call("c1", "read", { filePath: "src/a.ts" })),
    toolMsg(result("c1", "read", big("A"))),
    user("dos"),
    assistant(call("c2", "read", { filePath: "src/a.ts" })),
    toolMsg(result("c2", "read", big("B"))),
  ]
  pruneContext({ sessionID: "s2", messages }, store, cfg, 200000)
  assert.equal(isStub(messages[2].content[0].result.value), false)
  assert.equal(isStub(messages[5].content[0].result.value), false)
})

test("las herramientas protegidas nunca se podan", () => {
  const store = new SessionStore()
  const cfg = cfgWith()
  const messages = [
    user("uno"),
    assistant(call("c1", "write", { filePath: "src/a.ts", content: "x" })),
    toolMsg(result("c1", "write", big("A"))),
    user("dos"),
    assistant(call("c2", "write", { filePath: "src/a.ts", content: "y" })),
    toolMsg(result("c2", "write", big("B"))),
    user("tres"),
    assistant({ type: "text", text: "ok" }),
  ]
  pruneContext({ sessionID: "s3", messages }, store, cfg, 200000)
  assert.equal(isStub(messages[2].content[0].result.value), false)
})

test("un error viejo se poda cuando el reintento funciono", () => {
  const store = new SessionStore()
  const cfg = cfgWith()
  const messages = [
    user("uno"),
    assistant(call("c1", "bash", { command: "npm test" })),
    toolMsg({ type: "tool-result", id: "c1", name: "bash", result: { type: "error", value: big("fallo de red", 800) } }),
    user("dos"),
    assistant(call("c2", "bash", { command: "npm test" })),
    toolMsg(result("c2", "bash", big("OK", 900))),
    user("tres"),
    assistant({ type: "text", text: "listo" }),
  ]
  pruneContext({ sessionID: "s4", messages }, store, cfg, 200000)
  assert.equal(isStub(String(messages[2].content[0].result.value)), true)
  assert.equal(isStub(messages[5].content[0].result.value), false)
})

test("context_prune permite descartar por hash en el siguiente pase", async () => {
  const store = new SessionStore()
  const cfg = cfgWith()
  const ctx = { storage: { get: async () => undefined, set: async () => {} } }
  const tool = createContextTool(ctx, store, cfg)

  pruneContext({ sessionID: "s5", messages: duplicateMessages() }, store, cfg, 200000)
  const state = store.session("s5")
  const target = [...state.entries.values()].find((entry) => entry.name === "read" && !entry.pruned)
  assert.ok(target, "debe haber una salida podable registrada")

  const listed = await tool.execute({ action: "list" }, { sessionID: "s5" })
  assert.match(listed.content, new RegExp(target.hash))

  const discarded = await tool.execute({ action: "discard", targets: [[target.hash]] }, { sessionID: "s5" })
  assert.match(discarded.content, /Descartando/)

  const messages = duplicateMessages()
  pruneContext({ sessionID: "s5", messages }, store, cfg, 200000)
  assert.equal(isStub(messages[5].content[0].result.value), true)
})

test("replace reemplaza un bloque literal una sola vez", async () => {
  const store = new SessionStore()
  const cfg = cfgWith()
  const ctx = { storage: { get: async () => undefined, set: async () => {} } }
  const tool = createContextTool(ctx, store, cfg)
  const messages = [
    user("uno"),
    assistant({ type: "text", text: "INICIO-DEL-BLOQUE " + big("relleno", 100) + " FIN-DEL-BLOQUE." }),
    user("dos"),
    assistant({ type: "text", text: "otra cosa" }),
  ]
  store.session("s6")
  const queued = await tool.execute(
    { action: "replace", targets: [["INICIO-DEL-BLOQUE", "FIN-DEL-BLOQUE.", "[podado]"]] },
    { sessionID: "s6" },
  )
  assert.match(queued.content, /Reemplazos en cola: 1/)

  pruneContext({ sessionID: "s6", messages }, store, cfg, 200000)
  assert.equal(messages[1].content[0].text, "[podado]")
})

test("stats informa el acumulado de la sesion", async () => {
  const store = new SessionStore()
  const cfg = cfgWith()
  const ctx = { storage: { get: async () => ({ prunedCount: 10, savedTokens: 500 }), set: async () => {} } }
  const tool = createContextTool(ctx, store, cfg)
  pruneContext({ sessionID: "s7", messages: duplicateMessages() }, store, cfg, 200000)
  const out = await tool.execute({ action: "stats" }, { sessionID: "s7" })
  assert.match(out.content, /Sesion: \d+ salidas podadas/)
  assert.match(out.content, /Historico: 10 salidas/)
})

test("sin cambios no reporta poda", () => {
  const store = new SessionStore()
  const cfg = cfgWith()
  const messages = [user("uno"), assistant({ type: "text", text: "hola" })]
  const stats = pruneContext({ sessionID: "s8", messages }, store, cfg, 200000)
  assert.equal(stats.prunedCount, 0)
  assert.equal(stats.savedTokens, 0)
})
