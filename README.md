# oNiwa Provider

Anthropic-to-OpenAI proxy for **Claude Code** (`claude` CLI). Translates Anthropic Messages API requests to OpenAI Chat Completions so you can use OpenAI models with Claude Code.

## How it works

```
Claude Code               oNiwa Provider               OpenAI API
    |                           |                           |
    |-- POST /v1/messages ----->|                           |
    |   (Anthropic format)      |                           |
    |                           |-- POST /v1/chat/completions -->|
    |                           |   (OpenAI format)        |
    |                           |<-- streaming response ---|
    |<-- Anthropic format ------|                           |
```

## Quick Start

```bash
# Install
npm install && npm run build

# Set your OpenAI key and start
$env:OPENAI_API_KEY = "sk-your-openai-key"
npm start
```

## Connect Claude Code

### Option 1: Shell env vars (per session)

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:8080"
$env:ANTHROPIC_AUTH_TOKEN = "anything"
claude
```

### Option 2: settings.json (persistent)

Add to `~/.claude/settings.json` or `.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_AUTH_TOKEN": "my-proxy-key"
  }
}
```

### Option 3: VS Code extension

```json
{
  "claudeCode.environmentVariables": [
    { "name": "ANTHROPIC_BASE_URL", "value": "http://localhost:8080" },
    { "name": "ANTHROPIC_AUTH_TOKEN", "value": "my-proxy-key" }
  ]
}
```

## Model Mapping

Claude Code sends model IDs like `claude-sonnet-4-6-20250514`. Map them to OpenAI models:

```powershell
$env:MODEL_MAPPING = '{"claude-sonnet-4-6-20250514":"gpt-4o","claude-haiku-4-5-20251001":"gpt-4o-mini","claude-opus-4-5-20250514":"gpt-4o"}'
```

Or via settings.json — see `.env.example`.

You can also override which model ID Claude Code sends:

```powershell
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-6-20250514"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-5-20250514"
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `OPENAI_API_KEY` | — | Your OpenAI API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API |
| `PORT` | `8080` | Server port |
| `DEFAULT_MODEL` | `gpt-4o` | Fallback OpenAI model |
| `MODEL_MAPPING` | `{}` | Anthropic → OpenAI model map |
| `ANTHROPIC_AUTH_TOKEN` | — | Require this bearer token from clients |

## Use with any OpenAI-compatible API

```powershell
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
$env:OPENAI_API_KEY = "sk-..."
npm start
```
