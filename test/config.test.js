import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { DEFAULT_CONFIG, parseJsonc, resolveConfig } from "../lib/config.js"

const isolated = () => mkdtempSync(join(tmpdir(), "acp-cfg-"))

test("parseJsonc acepta comentarios y comas colgantes", () => {
  const text = `{
    // linea
    "a": 1, /* bloque */
    "b": "no // es comentario",
  }`
  assert.deepEqual(parseJsonc(text), { a: 1, b: "no // es comentario" })
})

test("parseJsonc no rompe llaves dentro de cadenas", () => {
  assert.deepEqual(parseJsonc('{"a":"x /* y */ z"}'), { a: "x /* y */ z" })
})

test("sin archivos devuelve los valores por defecto", () => {
  process.env.OPENCODE_CONFIG_DIR = isolated()
  const cfg = resolveConfig(isolated(), {})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.preset, "balanced")
  assert.deepEqual(cfg.protection, DEFAULT_CONFIG.protection)
})

test("el proyecto pisa la configuracion global", () => {
  const global = isolated()
  process.env.OPENCODE_CONFIG_DIR = global
  writeFileSync(join(global, "acp.jsonc"), '{"debug": true, "protection": {"recentTurns": 1}}')
  const project = isolated()
  mkdirSync(join(project, ".opencode"))
  writeFileSync(join(project, ".opencode", "acp.jsonc"), '{"debug": false, "preset": "compact"}')

  const cfg = resolveConfig(project, {})
  assert.equal(cfg.debug, false)
  assert.equal(cfg.protection.recentTurns, 1)
  assert.equal(cfg.preset, "compact")
})

test("las opciones del plugin ganan a los archivos", () => {
  process.env.OPENCODE_CONFIG_DIR = isolated()
  const cfg = resolveConfig(isolated(), { enabled: false, visibleHashes: false })
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.visibleHashes, false)
})

test("el preset verbose apaga las estrategias", () => {
  process.env.OPENCODE_CONFIG_DIR = isolated()
  const cfg = resolveConfig(isolated(), { preset: "verbose" })
  assert.equal(cfg.strategies.identicalCalls, false)
  assert.equal(cfg.strategies.oneFileOneView, false)
  assert.equal(cfg.protection.recentTurns, 3)
})
