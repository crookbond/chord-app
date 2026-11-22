# BYOK providers — configuration examples

Chord lets each user point the bot at **their own** LLM account
("bring your own key"). Set it in the app under **Settings → LLM model →
Bring your own**, or via `PUT /api/v1/me/model-key`. The key is encrypted
at rest (`users.model_key_ciphertext`) and used only for that user's turns;
everyone else keeps the system default.

On save, Chord makes one tiny test call to confirm the key + model work —
a bad key, wrong model name, or empty balance is rejected immediately
rather than failing mid-conversation. If a working key later dies or runs
out of credit, the bot tells *that user* to fix/top up their key and does
**not** fall back to the system key. See
[ADR 0044](../notes/0044-byok-failure-and-future-billing.md).

## The three providers

| `provider` | Talks to | `baseUrl` |
|---|---|---|
| `anthropic` | Anthropic (Claude) | ignored |
| `gemini` | Google Gemini | ignored |
| `openai` | OpenAI **and any OpenAI-compatible endpoint** | honored |

`openai` is the catch-all: it's the OpenAI SDK pointed at whatever
`baseUrl` you give it, so OpenRouter, DeepSeek-direct, Ollama, vLLM,
Together, etc. all go in as `provider: "openai"` with a base URL. Only the
`openai` provider reads `baseUrl`; Anthropic and Gemini ignore it.

## Direct providers

### OpenAI
- **Provider:** OpenAI
- **Model:** `gpt-4o-mini`, `gpt-5.4-mini`, … (whatever your account can call)
- **Base URL:** leave blank
- **API key:** `sk-…` from <https://platform.openai.com/api-keys>

### Anthropic (Claude)
- **Provider:** Anthropic (shown as "Claude")
- **Model:** `claude-sonnet-4-6`, `claude-haiku-4-5`, …
  ⚠️ **Dashes, not dots** — `claude-sonnet-4-6`, *not* `claude-sonnet-4.6`.
  The dotted form 404s and the save is rejected.
- **Base URL:** leave blank (ignored)
- **API key:** `sk-ant-…` from <https://console.anthropic.com/settings/keys>

### Google Gemini
- **Provider:** Gemini
- **Model:** `gemini-2.5-flash`, `gemini-2.5-pro`, …
- **Base URL:** leave blank (ignored)
- **API key:** from <https://aistudio.google.com/app/apikey>

## OpenAI-compatible endpoints (provider = `openai` + base URL)

### OpenRouter (aggregator — Claude/DeepSeek/Llama/… behind one key)
- **Easiest:** Settings → AI model → **Connect OpenRouter** (or ask Chord in chat). You sign in to
  OpenRouter, add credit and approve; Chord stores the key — nothing to copy. It starts on the model
  Chord uses now; type an OpenRouter model (`vendor/model`) in the Model box first to pick another.
  Needs `WEB_ORIGIN` set. See [ADR 0235](../notes/0235-connect-openrouter-instead-of-pasting-a-key.md).
- **By hand:**
- **Provider:** OpenAI
- **Base URL:** `https://openrouter.ai/api/v1`
- **Model:** OpenRouter slug — `deepseek/deepseek-chat`,
  `anthropic/claude-sonnet-4.6`, `meta-llama/llama-3.1-70b-instruct`, …
  Copy the exact slug from <https://openrouter.ai/models> (these use the
  upstream vendor's own formatting and *can* contain a dot).
- **API key:** `sk-or-v1-…` from <https://openrouter.ai/keys>
  (an OpenRouter key, **not** a DeepSeek/Anthropic key)

### DeepSeek (direct)
- **Provider:** OpenAI
- **Base URL:** `https://api.deepseek.com`
- **Model:** `deepseek-chat` (V3) or `deepseek-reasoner` (R1)
- **API key:** `sk-…` from <https://platform.deepseek.com/api_keys>

### Ollama (local models)
- **Provider:** OpenAI
- **Base URL:** `http://localhost:11434/v1`
- **Model:** `llama3.1`, `qwen2.5`, … (a model you've `ollama pull`-ed)
- **API key:** any non-empty string (Ollama ignores it, but the field is required)

### vLLM (self-hosted)
- **Provider:** OpenAI
- **Base URL:** `http://<host>:8000/v1`
- **Model:** the served model name you launched vLLM with
- **API key:** the token you configured (or any non-empty string if none)

> **Local endpoints:** `localhost` means the **Chord server's** localhost,
> not your phone or laptop. If the model runs on a different machine, use
> that machine's reachable address. The server must be able to reach the
> URL for validate-on-save to pass.

## Gotchas

- **`baseUrl` is OpenAI-only.** Choosing Anthropic or Gemini ignores it.
- **Full URL, ending at `/v1`** (where the endpoint uses it) — include the
  scheme; do **not** append `/chat/completions` (the SDK adds that).
- **Model IDs differ direct vs via OpenRouter.** Direct Anthropic is
  `claude-sonnet-4-6`; the same model on OpenRouter is the slug
  `anthropic/claude-sonnet-4.6`. Use the form that matches the endpoint.
- **Wrong key/model is caught on save**, not later (ADR 0044
  validate-on-save).
- **A dead/empty key fails your turns with a "fix your key" message** — no
  silent fallback to the system key (ADR 0044).

## Via the API

```bash
BASE=http://127.0.0.1:4000/api/v1

# Claude direct
curl -X PUT $BASE/me/model-key -H "x-chord-token: $TOK" -H 'content-type: application/json' \
  -d '{"provider":"anthropic","model":"claude-sonnet-4-6","apiKey":"sk-ant-..."}'

# DeepSeek via OpenRouter
curl -X PUT $BASE/me/model-key -H "x-chord-token: $TOK" -H 'content-type: application/json' \
  -d '{"provider":"openai","model":"deepseek/deepseek-chat","baseUrl":"https://openrouter.ai/api/v1","apiKey":"sk-or-v1-..."}'

# Clear (back to system default)
curl -X DELETE $BASE/me/model-key -H "x-chord-token: $TOK"
```

Request shape: `SetModelKeyRequest` in `kernel/src/types/user.ts`
(`provider` ∈ `openai|gemini|anthropic`, `model` + `apiKey` required,
`baseUrl` optional URL). Resolution + validation live in
`server/src/services/llm/factory.ts`; the bot subsystem reads the resolved
provider per turn — see [`docs/subsystems/bot.md`](../subsystems/bot.md).
