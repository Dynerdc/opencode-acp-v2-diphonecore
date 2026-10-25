# ACP v2 — Agentic Context Pruning para OpenCode V2

Port completo del plugin [`@tuanhung303/opencode-acp`](https://github.com/tuanhung303/opencode-agent-context-pruning)
(que solo funciona en OpenCode V1) sobre la API de plugins de **OpenCode V2**.

Reduce el gasto de contexto de forma automática: detecta salidas de herramientas que ya
no aportan, las reemplaza por stubs de una línea y deja que el agente pode a mano lo que
quiera con la herramienta `context_prune`.

```
ANTES                                   DESPUES
read(a.ts)      3.000 tok               read(a.ts)      3.000 tok   <- la ultima
edit(a.ts)      2.000 tok               edit(a.ts)      2.000 tok
read(a.ts)      3.000 tok    ─────►     read(a.ts)      [ACP pruned read() output: ...]
read(a.ts)      3.000 tok               read(a.ts)      [ACP pruned read() output: ...]
bash(ls)        1.000 tok               bash(ls)        1.000 tok
```

Cero dependencias npm. Solo `node:crypto`, `node:fs`, `node:path` y la API del host.

---

## Que hace

1. **Poda automatica** en cada peticion al modelo, antes de enviarla.
2. **Hash visible** en cada salida de herramienta (`<tool_hash>a1b2c3</tool_hash>`) para
   que el agente pueda referenciarla.
3. **Herramienta `context_prune`** con acciones `list`, `discard`, `distill`, `replace`,
   `stats` y `reset`.
4. **Comando `/acp`** con el estado actual (podado, tokens liberados, presion de contexto).
5. **Estadisticas persistentes** por sesion y acumuladas, guardadas con `ctx.storage`.

Nada de esto modifica tu historial guardado: el pase reescribe solo la copia que se envia
al modelo. Si recargas la sesion, el historial original sigue intacto.

---

## Requisitos

- OpenCode V2 (`opencode v2.1.4` o superior).
- Node 20+ (el que trae OpenCode sirve).
- Ninguna clave de API ni modelo especial.

---

## Instalacion

### Opcion A — instalador (recomendado)

```powershell
# desde la carpeta descomprimida
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Copia el plugin a `%USERPROFILE%\.config\opencode\plugins\acp-v2` y ejecuta las pruebas.
Reinicia OpenCode (o abre una sesion nueva) y lista:

```powershell
opencode plugin list
```

### Opcion B — a mano

Copia la carpeta completa a:

```
C:\Users\<tu-usuario>\.config\opencode\plugins\acp-v2\
    index.js
    package.json
    lib\config.js
    lib\prune.js
    lib\registry.js
    lib\tool.js
    lib\util.js
```

OpenCode descubre solo los directorios de `~/.config/opencode/plugins/`. No hace falta
tocar `opencode.json`.

### Opcion C — como paquete configurado

```jsonc
// ~/.config/opencode/opencode.json o ./opencode.jsonc
{
  "plugins": [
    { "package": "./plugins/acp-v2", "options": { "preset": "balanced" } }
  ]
}
```

El plugin expone `id: "mente.acp-v2"` y `setup(ctx)`, que es lo que V2 exige.

### Verificar que cargo

```powershell
Select-String -Path "$env:USERPROFILE\.local\share\opencode\log\opencode.log" `
  -Pattern 'acp-v2|failed to load plugin' | Select-Object -Last 5
```

Debe aparecer `loading plugin ... \plugins\acp-v2` y **ningun** `failed to load plugin`.

---

## Configuracion

Precedencia, de menor a mayor:

1. Valores por defecto del plugin.
2. `~/.config/opencode/acp.jsonc` (global).
3. `<proyecto>/.opencode/acp.jsonc` (por proyecto).
4. `options` del plugin en `opencode.json(c)`.

Copia [`acp.jsonc`](./acp.jsonc) como plantilla. Todo es opcional: sin archivo funciona
con el preset `balanced`.

### Opciones principales

| Clave | Default | Que hace |
|---|---|---|
| `enabled` | `true` | Apaga el plugin por completo. |
| `debug` | `false` | Logs `[acp]` en el log de OpenCode. |
| `visibleHashes` | `true` | Anade `<tool_hash>` a cada salida. |
| `preset` | `"balanced"` | `compact`, `balanced` o `verbose`. |
| `protectedTools` | ver abajo | Nunca se podan automaticamente. |
| `protectedFilePatterns` | `.env`, `*.pem`, ... | Archivos que no se podan. |
| `strategies.*` | ver abajo | Activa o desactiva cada estrategia. |
| `protection.recentTurns` | `2` | Turnos recientes intactos. |
| `protection.keepLastResults` | `4` | Ultimas N salidas siempre intactas. |
| `tokens.warningThreshold` | `0.7` | Aviso de presion alta. |
| `tokens.criticalThreshold` | `0.85` | Aviso de presion critica. |

Los presets ajustan `protection` y `strategies` de golpe:

- **compact** — poda agresiva (`recentTurns: 1`, `keepLastResults: 2`, purga errores viejos).
- **balanced** — el equilibrio por defecto.
- **verbose** — no poda nada automatico; solo deja `context_prune` manual.

---

## Las 8 estrategias

Se aplican en cada peticion. De cada grupo sobrevive **la ultima** llamada.

| # | Estrategia | Clave | Que elimina |
|---|---|---|---|
| 1 | Llamadas identicas | `identicalCalls` | Repeticiones con los mismos argumentos. |
| 2 | Un archivo, una vista | `oneFileOneView` | Lecturas/ediciones anteriores del mismo archivo. |
| 3 | Consultas de estado | `stateQueries` | `ls`, `pwd`, `git status`, `grep`... ya superados. |
| 4 | URLs repetidas | `sourceUrls` | La misma URL consultada antes. |
| 5 | Tareas | `todos` | Estados de todo-list ya reemplazados. |
| 6 | Snapshots | `snapshots` | Checkpoints/reverts superados. |
| 7 | Reintentos | `retryAttempts` | El error de un intento que luego funciono. |
| 8 | Entradas verbosas | `pruneToolInputs` | `content`/`patch`/`diff` gigantes en los argumentos. |

Extras opcionales:

- `truncateOldErrors` / `purgeErrors` — poda errores antiguos que nadie resolvio.

**Protecciones** (nunca se tocan automaticamente):

- Turnos recientes (`recentTurns`) y las ultimas N salidas (`keepLastResults`).
- Herramientas de `protectedTools`: `context_prune`, `task`, `todowrite`, `todoread`,
  `todo`, `batch`, `write`, `edit`, `apply_patch`.
- Archivos de `protectedFilePatterns`: secretos, `.env`, `*.pem`, `*.key`,
  `package.json`, `tsconfig.json`, `pyproject.toml`, `Cargo.toml`.

> Que `write`/`edit` esten protegidos no es un capricho: son el registro de lo que el
> agente ya cambio. Podarlos invita a repetir trabajo.

---

## Herramienta `context_prune`

Cada salida lleva su hash al final:

```
<tool_hash>a1b2c3</tool_hash>
```

| Accion | `targets` | Efecto |
|---|---|---|
| `list` | — | Salidas podables: hash, herramienta, tokens, primera linea. |
| `discard` | `[["a1b2c3"]]` | Reemplaza la salida por un stub. |
| `distill` | `[["a1b2c3","resumen"]]` | La reemplaza por tu resumen. |
| `replace` | `[["inicio","fin","[podado]"]]` | Reemplazo literal de un bloque. |
| `stats` | — | Sesion, historico y presion de contexto. |
| `reset` | — | Olvida las podas manuales pendientes. |

Reglas de `replace`, heredadas del original:

- El bloque debe medir 30 caracteres o mas.
- Al menos uno de los dos extremos debe medir mas de 15 caracteres.
- El marcador de inicio debe aparecer una sola vez.
- Se aplica una unica vez y se descarta.

Las podas manuales se aplican **en la siguiente peticion**; la herramienta solo las deja
en cola. Tambien puedes podar herramientas protegidas a mano (forzado), porque tu decides.

---

## Comando `/acp`

```
ACP — podado de contexto
  Sesion: 4 salidas podadas, ~12.400 tokens liberados
  Historico: 30 salidas, ~273.760 tokens
  Presion: 17% de 200k tokens (312 salidas)
```

Se inyecta como mensaje sintetico, no ocupa turno de usuario.

---

## Presion de contexto

Se calcula sobre **toda la conversacion** (texto, argumentos y salidas), no solo sobre las
salidas de herramientas:

```
presion = tokens_estimados / ventana_del_modelo
```

La ventana se lee de `ctx.model.list()` (cacheada 60 s). Si el modelo no la declara, se
usa 200.000 tokens. La estimacion es `caracteres / 4`, suficiente para decidir cuando
podar; no pretende ser exacta.

---

## Diferencias con el plugin original (V1)

El comportamiento y las reglas se conservan. Lo que cambia es la integracion:

| Aspecto | Original (V1) | Este port (V2) |
|---|---|---|
| Punto de entrada | `default async (ctx) => ({hooks})` | `{ id, setup(ctx) }` |
| Poda antes del request | `experimental.chat.messages.transform` | `ctx.session.hook("context")` |
| Hash en salidas | `chat.message` + partes sinteticas | `ctx.tool.hook("execute.after")` |
| Herramienta | `tool` en el objeto de hooks | `ctx.tool.transform` |
| Comando `/acp` | `command.execute.before` | `ctx.command.transform` |
| Estado persistente | archivo propio | `ctx.storage` |
| Dependencias | `zod`, `jsonc-parser`, `@anthropic-ai/tokenizer`, SDK V1 | **ninguna** |
| Compactacion nativa | la desactivaba desde un hook `config` | **no puede**: V2 no expone mutacion de config |
| Poda de bloques de razonamiento | si (hash de `reasoning`) | no: V2 no expone esas partes al hook |
| Herramienta sintetica `context_info` | si (DeepSeek/Kimi) | no: V2 ya inyecta el contexto del sistema |

Consecuencia practica de las dos ultimas filas: en V2 la compactacion nativa sigue activa
y puede resumir la conversacion antes de que el plugin pode. No es un conflicto —la
compactacion es un resumen de ultimo recurso y el plugin evita llegar a ella— pero si
quieres que el plugin tenga la primera y la ultima palabra, sube `compaction` en
`opencode.jsonc`:

```jsonc
{
  "compaction": {
    "auto": true,
    "keep": { "tokens": 15000 }
  }
}
```

El tokenizador tambien es distinto: el original usaba `@anthropic-ai/tokenizer`; aqui se
estima con `caracteres / 4`. Para decidir que podar es mas que suficiente y no arrastra
una dependencia.

---

## Limites conocidos

- **Solo afecta al request saliente.** El historial en disco no se toca; al recargar la
  sesion vuelven las salidas completas.
- **Estimacion de tokens heuristica.** No es el conteo exacto del proveedor.
- **No poda razonamiento.** V2 no expone los bloques de `reasoning` en el hook de contexto.
- **No desactiva la compactacion nativa.** V2 no permite mutar la config desde un plugin.
- **Estado en memoria.** Las podas pendientes se pierden si reinicias OpenCode; lo ya
  aplicado al request tampoco se guarda (por diseno).
- **Un archivo por grupo.** Si el agente alterna `read(a)` → `read(b)` → `read(a)`, la
  segunda lectura de `a` se conserva y la primera se poda: siempre gana la ultima.
- **El hash cambia si cambia la salida.** Es el hash de `nombre + argumentos + resultado`,
  asi que la misma llamada con otra salida da otro hash. Es intencional: identifica la
  salida concreta.

---

## Pruebas

```powershell
cd acp-v2
node --test "test/*.test.js"
```

22 pruebas: utilidades (hash estable, stubs, globs), configuracion (JSONC, precedencia,
presets) y nucleo (deduplicacion, protecciones, reintentos, `discard`, `distill`,
`replace`, `stats`, integridad del par `tool-call`/`tool-result`).

---

## Estructura

```
acp-v2/
├── index.js              entrada: setup, hooks, comando, cleanup
├── lib/
│   ├── config.js         defaults, presets, JSONC, precedencia
│   ├── prune.js          nucleo: 8 estrategias + poda manual
│   ├── registry.js       estado por sesion + persistencia
│   ├── tool.js           herramienta context_prune
│   └── util.js           hash, tokens, globs, stubs
├── test/                 22 pruebas con node:test
├── acp.jsonc             config de ejemplo comentada
├── install.ps1           instalador para Windows
├── LICENSE.txt           licencia MIT
└── package.json
```

---

## Creditos y licencia

Diseno original, estrategias y reglas: **tuanhung303**,
[opencode-agent-context-pruning](https://github.com/tuanhung303/opencode-agent-context-pruning).

Este port a V2 es una reescritura de la capa de integracion basada en el trabajo original.

Licencia **MIT**. Consulta [`LICENSE.txt`](./LICENSE.txt).

```
Copyright (c) 2025 opencode-acp (diseno original y estrategias de ACP)
Copyright (c) 2026 Dynerdc (port a OpenCode V2)
```