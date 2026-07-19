---
phase: 7
title: Lambda Deployment
status: completed
priority: P2
effort: 6h
dependencies:
  - 6
---

# Phase 7: Lambda Deployment

## Overview

Wrap the Express app in an AWS Lambda handler suitable for API Gateway + Lambda integration. Configure S3 client reuse for warm starts, environment validation, and CloudWatch Logs integration. Provide deployment configuration via CDK, SAM, or plain CloudFormation.

## Requirements

- Lambda handler wrapping Express app
- S3 client reuse across warm invocations
- Environment variable validation at cold start
- CloudWatch Logs log group for usage records
- API Gateway configuration (REST or HTTP API)
- IAM permissions for S3 bucket and CloudWatch Logs

## Architecture

```
API Gateway → Lambda (Express wrapped)
  → S3 client (reused singleton)
  → console.log → CloudWatch Logs (/aws/lambda/oniwa-provider)
```

## Related Code Files

- Create: `src/lambda.ts` — Lambda handler adapter
- Create: `infra/template.yaml` — SAM template (or CDK stack)
- Modify: `src/index.ts` — conditional startup (Lambda vs local)
- Modify: `package.json` — add build:lambda script

## Implementation Steps

1. **Create `src/lambda.ts`**
   - Export `handler` function: `(event, context, callback) => void`
   - Pattern:
     ```ts
     import serverlessExpress from '@vendia/serverless-express';
     import { app } from './index';
     export const handler = serverlessExpress({ app });
     ```
   - Alternative (no external dependency): create a simple adapter that:
     - Parses API Gateway event → Express-compatible req/res
     - Calls app.handle(req, res)
     - Returns formatted API Gateway response
   - For simplicity: use `@vendia/serverless-express` (well-maintained, handles edge cases)
   - Ensure S3 client is initialized once (module-level singleton)

2. **Update `src/index.ts` — conditional startup**
   - Wrap `app.listen()` in a check:
     ```ts
     if (!process.env.AWS_EXECUTION_ENV) {
       app.listen(config.port, () => { ... });
     }
     export { app };
     ```
   - This allows `lambda.ts` to import `app` without starting the HTTP server
   - In Lambda environment, the handler manages the server lifecycle

3. **Environment validation at cold start**
   - In `src/lambda.ts`, on first invocation:
     - Validate required env vars: `S3_BUCKET`, `OPENAI_API_KEY`
     - Warn if `ADMIN_API_KEY` is missing (admin endpoints won't work)
     - Warn if `CW_LOG_GROUP` is not set (metrics queries won't work)
   - Log validation results via `console.log` (visible in CloudWatch)

4. **IAM permissions**
   - Minimal required permissions:
     ```json
     {
       "Effect": "Allow",
       "Action": [
         "s3:GetObject",
         "s3:PutObject",
         "s3:DeleteObject",
         "s3:ListBucket"
       ],
       "Resource": ["arn:aws:s3:::my-bucket", "arn:aws:s3:::my-bucket/*"]
     },
     {
       "Effect": "Allow",
       "Action": [
         "logs:StartQuery",
         "logs:GetQueryResults",
         "logs:DescribeLogGroups"
       ],
       "Resource": "*"
     }
     ```

5. **Create deployment package**
   - `package.json` script: `"build:lambda": "tsc && cp package.json dist/ && cd dist && npm install --production && zip -r ../deploy.zip ."`
   - Or build with esbuild for smaller package: `npx esbuild src/lambda.ts --bundle --platform=node --target=node20 --outfile=dist/lambda.js --external:@aws-sdk/*`
   - Bundling with esbuild preferred: excludes AWS SDK (already in Lambda runtime), produces single file, faster cold starts

6. **API Gateway configuration**
   - REST API or HTTP API with proxy integration
   - All paths forwarded to Lambda (`/{proxy+}`)
   - No additional API Gateway auth (auth is in the Lambda)
   - Request body passthrough (no transformation)
   - 30s timeout minimum (for streaming responses)

7. **CloudWatch Logs setup**
   - Log group: `/aws/lambda/oniwa-provider`
   - Retention: 30 days (default, configurable)
   - Usage records automatically captured from `console.log`
   - No additional subscription filter needed

## Deployment Verification

```
# After deploying Lambda + API Gateway:
export ANTHROPIC_BASE_URL=https://{api-id}.execute-api.{region}.amazonaws.com/v1
export ANTHROPIC_AUTH_TOKEN=sk-<admin-generated-user-token>

# Verify proxy works
claude "hello"

# Verify admin API
curl -H "x-api-key: $ADMIN_API_KEY" $ANTHROPIC_BASE_URL/admin/users

# Verify metrics (after some usage)
curl -H "x-api-key: $ADMIN_API_KEY" "$ANTHROPIC_BASE_URL/admin/metrics?period=day"
```

## Success Criteria

- [ ] Lambda handler invokes successfully via API Gateway
- [ ] S3 operations work (read user, write usage)
- [ ] Usage records appear in CloudWatch Logs
- [ ] Metrics queries complete successfully (may need warm-up requests first)
- [ ] Warm invocations reuse S3 client (no cold start penalty)
- [ ] Cold start < 2s (esbuild bundle)
- [ ] Deployment script works (zipped or esbuilt artifact)
- [ ] `npm run build` compiles without errors
