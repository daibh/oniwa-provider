# oNiwa Provider

Multi-provider proxy for **Claude Code** (`claude` CLI). Translates Anthropic Messages API to any OpenAI-compatible or Anthropic provider, with per-user auth, usage tracking, and cost metrics.

## Architecture

```
Claude Code               oNiwa Provider               Provider API
    |                           |                           |
    |-- POST /v1/messages ----->|                           |
    |   (Anthropic format)      |                           |
    |                           |-- POST /v1/chat/completions -->|
    |                           |   (OpenAI format)        |  or passthrough (Anthropic format)
    |                           |<-- streaming response ---|
    |<-- Anthropic format ------|                           |
```

- **openai format**: translates Anthropic → OpenAI request, forwards, translates response back
- **anthropic format**: passthrough with API key swap (for Claude via other providers)

## Quick Start (local)

```bash
npm install && npm run build

# Single provider
$env:PROVIDERS = '{"default":{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-...","format":"openai"}}'
$env:MODEL_ROUTING = '{"gpt-4o":"default","gpt-4o-mini":"default"}'
$env:MODEL_MAPPING = '{"claude-sonnet-4-6-20250514":"gpt-4o","claude-haiku-4-5-20251001":"gpt-4o-mini"}'

npm start
```

## Connect Claude Code

Create a token (or let it auto-create on first request), then set:

### Shell (per session)
```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:8080"
$env:ANTHROPIC_AUTH_TOKEN = "sk-any-token-works"
claude
```

### settings.json (persistent)
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_AUTH_TOKEN": "my-proxy-key"
  }
}
```

**Unknown tokens auto-create a user** — zero-config migration per developer. If user management is not needed, set `ANTHROPIC_AUTH_TOKEN` to anything and skip S3 setup.

## Configuration

### Providers

Define one or more AI providers:

```powershell
$env:PROVIDERS = '{
  "openai":{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-...","format":"openai"},
  "deepseek":{"baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-...","format":"openai"},
  "anthropic":{"baseUrl":"https://api.anthropic.com/v1","apiKey":"sk-ant-...","format":"anthropic"}
}'
```

Supported formats: `openai` (GPT, DeepSeek, etc.), `anthropic` (Claude passthrough).

### Model routing

```powershell
$env:MODEL_MAPPING = '{"claude-sonnet-4-6-20250514":"gpt-4o","claude-haiku-4-5-20251001":"gpt-4o-mini"}'
$env:MODEL_ROUTING = '{"gpt-4o":"openai","gpt-4o-mini":"deepseek"}'
```

- `MODEL_MAPPING`: Anthropic model ID → provider model ID
- `MODEL_ROUTING`: provider model ID → provider ID from `PROVIDERS`

The model ID Claude Code sends can be overridden:

```powershell
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-6-20250514"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-5-20250514"
```

### All env vars

| Var | Default | Required | Description |
|-----|---------|----------|-------------|
| `PROVIDERS` | — | Yes | JSON map of provider configs |
| `MODEL_ROUTING` | `{}` | — | Model → provider routing |
| `MODEL_MAPPING` | `{}` | — | Anthropic model → provider model ID |
| `MODEL_API_KEYS` | `{}` | — | Per-model API key overrides |
| `MODEL_CONTEXT_LIMITS` | `{}` | — | Per-model context windows |
| `MAX_OUTPUT_TOKENS` | `16384` | — | Hard cap on output tokens |
| `MAX_IMAGE_SIZE` | `5242880` | — | Max base64 image bytes (0 = block) |
| `PORT` | `8080` | — | HTTP server port |
| `ADMIN_API_KEY` | — | For admin | Admin API key for `/v1/admin/*` |
| `S3_BUCKET` | — | For users | S3 bucket for user profiles & tokens |
| `AWS_REGION` | `us-east-1` | — | AWS region |
| `CW_LOG_GROUP` | `/aws/lambda/oniwa-provider` | — | CloudWatch Logs for usage records |

## Admin API

All admin endpoints require `x-api-key: <ADMIN_API_KEY>` header.

### Users

```
POST   /v1/admin/users                         # Create user (returns token)
GET    /v1/admin/users                          # List all users
GET    /v1/admin/users/:id                      # Get user details + tokens
DELETE /v1/admin/users/:id                      # Deactivate user
POST   /v1/admin/users/:id/tokens               # Generate new API token
DELETE /v1/admin/users/:id/tokens/:tokenId      # Revoke token
```

### Pricing

```
GET  /v1/admin/pricing                          # Read pricing config
PUT  /v1/admin/pricing                          # Update pricing config
```

Pricing format per model: `{"gpt-4o":{"input":2.5,"output":10,"cachedInput":1.25}}` (rates per 1M tokens).

### Metrics

```
GET  /v1/admin/metrics?period=month             # Global usage + cost
GET  /v1/admin/users/:id/usage?period=month     # Per-user usage + cost
```

Supported periods: `day`, `week`, `month`, `quarter`, `year`. Also accepts `from`/`to` ISO dates.

Cost is calculated at query time by multiplying token counts against pricing rates.

## AWS Deployment (Terraform)

### Prerequisites

- AWS CLI configured with credentials
- Terraform >= 1.6
- An S3 bucket for user profiles (create manually or use existing)
- Node.js 20+

### 1. Build Lambda bundle

```powershell
npm run build:lambda
```

Creates `dist/lambda.js` — single-file esbuild bundle excluding `@aws-sdk/*` (provided by Lambda runtime).

### 2. Deploy with Terraform

```bash
cd infra

terraform init

terraform apply \
  -var="s3_bucket_name=my-oniwa-provider-data" \
  -var="admin_api_key=sk-admin-secret" \
  -var='providers_json={"default":{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-...","format":"openai"}}' \
  -var='model_routing_json={"gpt-4o":"default","gpt-4o-mini":"default"}' \
  -var='model_mapping_json={"claude-sonnet-4-6-20250514":"gpt-4o","claude-haiku-4-5-20251001":"gpt-4o-mini"}'
```

This provisions:

| Resource | Purpose |
|----------|---------|
| Lambda function (`oniwa-provider`) | Express proxy with `@vendia/serverless-express` |
| IAM role + policy | S3 read/write, CloudWatch Logs Insights |
| CloudWatch Log Group | Usage records (30d retention) |
| API Gateway v2 (HTTP) | Public endpoint, auto-deploy |

Outputs the `api_url`.

### 3. Configure Claude Code

```powershell
$env:ANTHROPIC_BASE_URL = "https://<api-id>.execute-api.<region>.amazonaws.com"
$env:ANTHROPIC_AUTH_TOKEN = "<user-token-from-admin-api>"
claude
```

### Updating

```bash
npm run build:lambda
cd infra && terraform apply
```

`source_code_hash` triggers Lambda update only when `dist/lambda.js` changes. To avoid passing `-var` flags every time, create `infra/terraform.tfvars`:

```hcl
s3_bucket_name        = "my-oniwa-provider-data"
admin_api_key         = "sk-admin-secret"
providers_json        = "{\"default\":{\"baseUrl\":\"https://api.openai.com/v1\",\"apiKey\":\"sk-...\",\"format\":\"openai\"}}"
model_routing_json    = "{\"gpt-4o\":\"default\",\"gpt-4o-mini\":\"default\"}"
model_mapping_json    = "{\"claude-sonnet-4-6-20250514\":\"gpt-4o\",\"claude-haiku-4-5-20251001\":\"gpt-4o-mini\"}"
```

Then just `terraform apply` with no flags. **Do not commit** `terraform.tfvars` if it contains secrets (add to `.gitignore`).

### Manual deploy (no Terraform)

```bash
npm run build:lambda
Compress-Archive -Path dist/lambda.js -DestinationPath deploy.zip
aws lambda update-function-code --function-name oniwa-provider --zip-file fileb://deploy.zip
```
