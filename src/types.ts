export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  metadata?: Record<string, string>;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface AnthropicStreamEvent {
  type:
    | "message_start"
    | "message_delta"
    | "message_stop"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "ping";
  message?: AnthropicResponse;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?:
    | AnthropicTextDelta
    | AnthropicInputJSONDelta
    | { stop_reason: string; stop_sequence: string | null };
  usage?: { output_tokens: number };
}

export interface AnthropicTextDelta {
  type: "text_delta";
  text: string;
}

export interface AnthropicInputJSONDelta {
  type: "input_json_delta";
  partial_json: string;
}

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | OpenAIContentPart[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  max_tokens?: number;
  max_completion_tokens?: number;
  user?: string;
}

export interface OpenAIResponse {
  id: string;
  object: string;
  model: string;
  choices: {
    index: number;
    message: OpenAIMessage;
    finish_reason: string | null;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface OpenAIStreamChunk {
  id: string;
  object: string;
  model: string;
  choices: {
    index: number;
    delta: Partial<OpenAIMessage>;
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export type ProviderFormat = "openai" | "anthropic";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  format: ProviderFormat;
}

export interface UserToken {
  id: string;
  prefix: string;
  hashedToken: string;
  createdAt: string;
  revoked?: boolean;
}

export interface UserProfile {
  id: string;
  name: string;
  active: boolean;
  tokens: UserToken[];
  createdAt: string;
  migrated?: boolean;
}

export interface PricingConfig {
  [model: string]: {
    input: number;
    output: number;
    cachedInput: number;
  };
}

export interface UsageRecord {
  type: "usage";
  requestId: string;
  userId: string;
  model: string;
  provider: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  streaming: boolean;
}

export interface Config {
  port: number;
  modelMapping: Record<string, string>;
  modelApiKeys: Record<string, string>;
  modelContextLimits: Record<string, number>;
  maxOutputTokens: number;
  maxImageSize: number;
  providers: Record<string, ProviderConfig>;
  modelRouting: Record<string, string>;
  adminApiKey: string;
  s3Bucket: string;
  awsRegion: string;
  logsGroupName: string;
}

export interface UsageQuery {
  period?: "day" | "week" | "month" | "quarter" | "year";
  from?: string;
  to?: string;
}

export interface ModelMetrics {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  requests: number;
  cost: number;
}

export interface MetricsResponse {
  period: string;
  start: string;
  end: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  byModel: Record<string, ModelMetrics>;
  totalCost: number;
}
