---
name: dsh-config
description: >-
  Edit this DSH installation's real configuration: add or change a model provider
  (baseURL, apiKeyEnv, models), change the default model, and add or rewrite an
  agent preset (persona prompt, tool rows, skills) in the profile patch files.
  Use when the user asks to "add a model", "add a provider/relay", "change the
  system prompt", "disable a tool", "create an agent preset", "switch the default
  agent", or "改 harness".
---

# dsh-config

DSH is a Cordis composition. Everything a session's agent "is" — its prompt
layers, tools, skills, model — is a row in a YAML patch file. There is no
separate config database, so editing those files **is** changing the harness.

Edit the files directly. Do not invent a second config format, and do not add
shell/`sed` layers on top: the loader watches the profile patches and reloads
live.

## 1. Which file

Layer order, weakest to strongest:

| Layer | File | Holds |
|---|---|---|
| bundle rows | `.../node_modules/@deepseek-ai/dsh-*/**/cordis.patch.yml` | shipped defaults — never edit |
| profile rows | `$DSH_HOME/profiles/<profile>/cordis.patch.yml` | this profile: default model, preset overrides |
| home rows | `$DSH_HOME/cordis.patch.yml` | every profile; **outranks** the profile layer |
| `--patch` | `dsh --patch ./try.yml …` | one-off experiments, highest |

`$DSH_HOME` defaults to `~/.dsh`; the running profile is usually `web`.

Bundle presets live in
`.../node_modules/@deepseek-ai/dsh-web-app/presets/{standard,ptc,minimal,cordis}.patch.yml`.
Read them to learn a row's shape; override them from the profile patch.

## 2. Patch semantics (get this wrong and nothing happens)

A patch file is a YAML array. Each entry is one of:

```yaml
# Override an existing row, by id. `name` must match the row it targets.
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config: { ... }

# Disable a row without deleting it.
- id: skill-filesystem
  disabled: true

# Append new rows to the root (or to a group, with `id:` + `insert:`).
- insert:
    - id: preset-mine
      name: '@deepseek-ai/dsh-agent-preset'
      config: { ... }
```

Rules the loader enforces:

- The override is **per key, not deep**: `target[key] = value`. Writing a row
  with `config:` replaces that row's whole config object. To change one field
  you must restate the rest.
- `name` mismatch ⇒ the entry is skipped with `patch: name mismatch for …`.
- Unknown id ⇒ `patch: entry … not found`.
- Later layers win. Home beats profile; `--patch` beats both.
- `!!js` expressions are allowed (`disabled: !!js process.platform === 'win32'`).

## 3. Add a model provider

Providers live in the `llm-pi-ai` row's `config.providers` dict, keyed by the
route name you then use as `provider`. On this machine that row is in the
**home** patch, `~/.dsh/cordis.patch.yml`.

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      my-relay:                       # provider route id
        api: anthropic-messages       # openai-completions | openai-responses | anthropic-messages
        baseURL: http://192.168.8.77:8180
        apiKeyEnv: MY_RELAY_API_KEY   # a NAME, never the secret
        displayName: My relay
        models:
          - id: some-model
            contextWindow: 262144
            maxTokens: 32768
            input: [text]             # text | image
            reasoningEfforts:         # optional; omit for non-reasoning models
              high: high
```

Model row fields: `id` (required), `name`, `contextWindow`, `maxTokens`,
`input`, `reasoningEfforts` (`false` disables them), `compat`.
Provider fields: `api`, `baseURL`, `apiKeyEnv`, `displayName`, `models`,
`modelOverrides`, `compat`, `defaultContextWindow`, `defaultMaxTokens`,
`defaultInput`, `headers`, `reasoning`, `thinkingBudgets`, `timeoutMs`,
`streamIdleTimeoutMs`, `retryPolicy`.

The secret itself:

- `apiKeyEnv` is only a credential **reference**. The value is resolved by the
  credentials service (`~/.dsh/.credentials.yaml`, written by the Web Models
  page) or from the Host process environment under that exact name.
- Never write a key into a patch file or a session.
- After adding a route, pick it with `/model` (Web: the model picker) or make it
  the default — next section.

**Restating the whole `providers` dict is required** when you override
`llm-pi-ai` in a stronger layer, because `config` replaces wholesale. Prefer
editing the existing block in place over adding a second override.

**Getting the ids**: `curl -s H 'Authorization: Bearer …' {baseURL}/models` (or
the Anthropic spelling `/v1/models`) lists what an upstream serves. The Web
Models page's "fetch available models" action and the TUI provider panel's `f`
key do the same through the Host — but discovery is **adoption, not sync**: a
listing carries no capacities or compat, so the ids land in a draft and
`contextWindow`/`maxTokens` still come from the catalog or hand entry.

## 4. Add a model to an existing provider

A model is an entry in the provider's `models` list; the route id is
`<provider>:<model-id>`. Two cases:

**The installed pi-ai catalog already knows the model** (most first-party
models do): tweak it with `modelOverrides`, which only needs the fields you
change — no restating the list:

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      deepseek-relay:
        modelOverrides:
          deepseek-v4.1: { contextWindow: 262144, maxTokens: 65536 }
```

**A model the catalog does not know** (anything behind a relay/gateway): add it
to `models`. A non-empty `models` **replaces** the served catalog for that
provider, so the list must contain every model the route should serve — old
entries disappear if you omit them. `modelOverrides` may not sit beside a
`models` list; declare the fields on the entries directly.

Then pick it per session (`/model`) or make it the default — next section.
Verify the route resolves: `dsh --dump-config --profile web | grep -A3 the-model-id`.

## 5. Change the default model

`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-relay
    model: deepseek-v4.1-flash
```

This is the default for **new** agents; existing sessions keep their own
selection (stored in the session log).

## 6. Agent presets = the harness

A preset declares one agent: `{id, name?, description?, order?, plugins: [...]}`.
Each plugin row is `{id, name, disabled?, config?}`.

```yaml
- id: preset-standard                     # patch row id
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard                          # preset id shown in the UI
    order: 1
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config: { prefix: 'You are a coding agent.' }
      - id: agent-instructions
        name: '@deepseek-ai/dsh-agent-instructions'
        config: { maxBytes: 65536 }
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
      - id: tool-pwsh
        name: '@deepseek-ai/dsh-tool-pwsh'
        disabled: true
```

- **Override a shipped preset**: add a row with the same `id` (`preset-standard`)
  and `name`, and repeat the **entire** `plugins` array with your changes. Copy
  the shipped file first, edit it, and paste; a partial array silently drops
  the omitted plugins.
- **New preset**: `- insert:` a row with a fresh `preset-<id>`; `config.id` is
  what the UI shows. Then make it the default. `default` is **required** by the
  registry schema, so restate it — an override replaces `config` wholesale:

  ```yaml
  - id: agent-preset-registry
    name: '@deepseek-ai/dsh-agent-preset-registry'
    config:
      default: standard          # required: fallback when selectedDefault is unset
      selectedDefault: my-agent  # what new sessions compose
  ```

  The Web settings page does the same merge for you; hand-editing must not.

- **Prompt**: `persona.config.prefix` **replaces** the deployment persona (it
  occupies the same `deployment:persona-prefix` slot). Instructions come from
  `agent-instructions` (AGENTS.md, capped by `maxBytes`) and `time-context`.
  Tools contribute their own system-prompt sections, so removing or disabling a
  tool removes its prompt text too.
- **Tools**: every `tool-*` / `command-*` / `skill-*` row is a plugin. Disable
  with `disabled: true`; swap an implementation by pointing at another package
  (e.g. `@deepseek-ai/dsh-tool-bash-persistent`).
- **Skills**: the host-level `skill-filesystem` row is disabled in the web
  profile — each preset mounts its own. The default roots are
  `$DSH_HOME/skills`, `~/.agents/skills`, `<project>/.dsh/skills` and
  `<project>/.agents/skills`; extra roots go in that preset's plugin row:
  `config: { customSkillDirs: ['/abs/path'] }`.

## 7. Verify before you walk away

```bash
# Effective composition, after all layers are applied:
dsh --dump-config --profile web | grep -nB2 -A12 'preset-standard'

# Warnings the loader logged while composing (mismatched ids/names land here):
dsh --dump-config --profile web 2>&1 | grep -i 'patch:'

# The patch/entry JSON Schema, when you are unsure a field name exists:
dsh --dump-config-schema | head -c 2000

# How the tree looks without your overrides (to diff against):
dsh --dump-default-config --profile web | grep -nA12 'preset-standard'
```

`--dump-config` rewrites the generated `cordis.yml` — that file is a build
artifact, never edit it.

The running Host watches these files (`dsh-hmr`, "profile configuration reloads
by default"), so a save applies without a restart:

- providers/models: new routings are picked up by the router; an existing
  session keeps its model until re-selected.
- preset rows: **new** sessions compose the new preset; running agents keep the
  composition they mounted. Restart the session (or the Host) to remount.

## 8. Safety

- Back up before editing: `cp cordis.patch.yml cordis.patch.yml.bak`.
- A YAML syntax error in a patch stops the Host from booting. Keep the edit
  small, then run the `--dump-config` check above.
- Never put secrets in patches; never edit bundle files (upgrades overwrite
  them); never edit `cordis.yml`.
- To test a change without touching the real config:
  `dsh --profile web --patch /tmp/try.patch.yml`.
