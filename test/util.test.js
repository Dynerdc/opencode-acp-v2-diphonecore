import assert from "node:assert/strict"
import test from "node:test"

import {
  estimateTokens,
  isProtectedPath,
  isStub,
  matchesGlob,
  shortHash,
  stableStringify,
  stripHashMarker,
  truncate,
} from "../lib/util.js"

test("stableStringify ordena claves y es estable", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(stableStringify({ a: [1, { d: 1, c: 2 }] }), '{"a":[1,{"c":2,"d":1}]}')
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
})

test("shortHash es deterministico y de seis caracteres", () => {
  assert.equal(shortHash("hola"), shortHash("hola"))
  assert.match(shortHash("hola"), /^[0-9a-f]{6}$/)
  assert.notEqual(shortHash("hola"), shortHash("hola2"))
})

test("estimateTokens aproxima a 4 caracteres por token", () => {
  assert.equal(estimateTokens(""), 0)
  assert.equal(estimateTokens("abcd"), 1)
  assert.equal(estimateTokens("a".repeat(400)), 100)
})

test("stripHashMarker quita el marcador sin tocar el resto", () => {
  assert.equal(stripHashMarker("linea\n<tool_hash>abc123</tool_hash>"), "linea")
  assert.equal(stripHashMarker("sin marcador"), "sin marcador")
  assert.equal(stripHashMarker(""), "")
})

test("isStub reconoce stubs y no falsos positivos", () => {
  assert.equal(isStub("[ACP pruned read() output: x]"), true)
  assert.equal(isStub("[ACP distilled read() output: x]"), true)
  assert.equal(isStub("hola"), false)
  assert.equal(isStub(""), false)
})

test("matchesGlob soporta ** y *", () => {
  assert.equal(matchesGlob("src/a.ts", "**/*.ts"), true)
  assert.equal(matchesGlob("a.ts", "**/*.ts"), true)
  assert.equal(matchesGlob("src/deep/a.js", "**/*.ts"), false)
  assert.equal(matchesGlob("C:\\x\\.env", "**/.env"), true)
})

test("isProtectedPath aplica los patrones", () => {
  assert.equal(isProtectedPath("C:/repo/.env", ["**/.env"]), true)
  assert.equal(isProtectedPath("C:/repo/src/a.ts", ["**/.env"]), false)
  assert.equal(isProtectedPath(undefined, ["**/.env"]), false)
})

test("truncate recorta y marca", () => {
  assert.equal(truncate("abc", 10), "abc")
  assert.equal(truncate("a".repeat(50), 10), "a".repeat(9) + "\u2026")
})
