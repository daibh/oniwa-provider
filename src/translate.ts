import {
  AnthropicRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicImageBlock,
  AnthropicResponse,
  AnthropicStreamEvent,
  AnthropicTextDelta,
  AnthropicInputJSONDelta,
  OpenAIRequest,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIResponse,
  OpenAIStreamChunk,
} from "./types";

function mapModel(anthropicModel: string, modelMapping: Record<string, string>): string {
  if (modelMapping[anthropicModel]) return modelMapping[anthropicModel];
  return anthropicModel;
}

function extractTextFromContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function anthropicContentToOpenAI(messages: AnthropicMessage[], maxImageSize: number): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role as "user" | "assistant", content: msg.content });
      continue;
    }

    if (msg.role === "user") {
      const textParts: string[] = [];
      const imageParts: { type: "image_url"; image_url: { url: string; detail: "low" } }[] = [];
      let skippedImages = 0;

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "image") {
          const img = block as AnthropicImageBlock;
          if (img.source.data.length <= maxImageSize) {
            imageParts.push({
              type: "image_url",
              image_url: {
                url: `data:${img.source.media_type};base64,${img.source.data}`,
                detail: "low",
              },
            });
          } else {
            skippedImages++;
          }
        }
      }

      if (imageParts.length > 0) {
        const contentArr: import("./types").OpenAIContentPart[] = [];
        if (textParts.length > 0) {
          contentArr.push({ type: "text", text: textParts.join("\n") });
        }
        contentArr.push(...imageParts);
        result.push({ role: "user", content: contentArr });
      } else {
        let text = textParts.join("\n") || " ";
        if (skippedImages > 0) {
          text += `\n[${skippedImages} image(s) omitted (too large)]`;
        }
        result.push({ role: "user", content: text });
      }
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          const tb = block as AnthropicToolUseBlock;
          toolCalls.push({
            id: tb.id,
            type: "function",
            function: {
              name: tb.name,
              arguments: JSON.stringify(tb.input),
            },
          });
        }
      }

      const oaiMsg: OpenAIMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : null,
      };
      if (toolCalls.length > 0) {
        oaiMsg.tool_calls = toolCalls;
      }
      result.push(oaiMsg);
    } else if (msg.role === "user" && msg.content.some((b) => b.type === "tool_result")) {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const tr = block as AnthropicToolResultBlock;
          result.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === "string" ? tr.content : extractTextFromContent(tr.content),
          });
        } else if (block.type === "text") {
          const last = result[result.length - 1];
          if (last && last.role === "user") {
            last.content = (last.content || "") + "\n" + (block as AnthropicTextBlock).text;
          } else {
            result.push({ role: "user", content: (block as AnthropicTextBlock).text });
          }
        }
      }
    }
  }

  return result;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

function estimateMessagesTokens(messages: OpenAIMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(JSON.stringify(m));
  }
  return total;
}

const MIN_OUTPUT_MARGIN = 4000;

function truncateMessages(
  messages: OpenAIMessage[],
  contextLimit: number
): OpenAIMessage[] {
  const estimated = messages.map((m) => estimateTokens(JSON.stringify(m)));
  const totalTokens = estimated.reduce((a, b) => a + b, 0);

  const budget = contextLimit - MIN_OUTPUT_MARGIN;
  if (totalTokens <= budget) return messages;

  const systemIdx = messages[0]?.role === "system" ? 0 : -1;

  const truncated: OpenAIMessage[] = [];
  let running = 0;

  if (systemIdx >= 0) {
    truncated.push(messages[0]);
    running = estimated[0];
  }

  for (let i = messages.length - 1; i > systemIdx; i--) {
    if (running + estimated[i] <= budget) {
      truncated.splice(systemIdx >= 0 ? 1 : 0, 0, messages[i]);
      running += estimated[i];
    }
  }

  if (truncated.length <= (systemIdx >= 0 ? 1 : 0)) {
    const keepIdx = systemIdx >= 0 ? systemIdx + 1 : 0;
    truncated.push(messages[keepIdx]);
    running += estimated[keepIdx];
  }

  const dropped = messages.length - truncated.length;
  if (dropped > 0) {
    console.log(`[truncate] dropped ${dropped}/${messages.length} messages (est. ${totalTokens} > ${contextLimit}), kept ${running} tokens`);
  }

  return truncated;
}

export function anthropicToOpenAI(
  req: AnthropicRequest,
  modelMapping: Record<string, string>,
  maxOutputTokens: number = 16384,
  modelContextLimits: Record<string, number> = {},
  maxImageSize: number = 5242880,
  tokenParam: "max_completion_tokens" | "max_tokens" = "max_completion_tokens"
): OpenAIRequest {
  const oaiMessages: OpenAIMessage[] = [];

  if (req.system) {
    const systemText = typeof req.system === "string"
      ? req.system
      : req.system.map((b) => b.text).join("\n");
    oaiMessages.push({ role: "system", content: systemText });
  }

  oaiMessages.push(...anthropicContentToOpenAI(req.messages, maxImageSize));

  const resolvedModel = mapModel(req.model, modelMapping);
  const contextLimit = modelContextLimits[resolvedModel] || 128000;

  const truncatedMessages = truncateMessages(oaiMessages, contextLimit);
  const estimatedPromptTokens = estimateMessagesTokens(truncatedMessages);
  const remainingForOutput = contextLimit - estimatedPromptTokens - MIN_OUTPUT_MARGIN;
  const cappedMaxTokens = Math.min(
    req.max_tokens,
    maxOutputTokens,
    Math.max(1, remainingForOutput)
  );

  const useMaxCompletion = tokenParam === "max_completion_tokens";

  const oaiReq: OpenAIRequest = {
    model: resolvedModel,
    messages: truncatedMessages,
    stream: req.stream,
  };

  if (useMaxCompletion) {
    oaiReq.max_completion_tokens = cappedMaxTokens;
  } else {
    oaiReq.max_tokens = cappedMaxTokens;
  }

  if (!useMaxCompletion) {
    oaiReq.temperature = req.temperature;
    oaiReq.top_p = req.top_p;
  }

  if (req.stop_sequences && req.stop_sequences.length > 0) {
    oaiReq.stop = req.stop_sequences.length === 1 ? req.stop_sequences[0] : req.stop_sequences;
  }

  if (req.stream) {
    oaiReq.stream_options = { include_usage: true };
  }

  if (req.metadata?.user_id) {
    oaiReq.user = req.metadata.user_id;
  }

  if (req.tools && req.tools.length > 0) {
    oaiReq.tools = req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema as Record<string, unknown>,
      },
    }));

    if (req.tool_choice) {
      if (req.tool_choice.type === "any" || req.tool_choice.type === "tool") {
        oaiReq.tool_choice = {
          type: "function",
          function: { name: req.tool_choice.name || req.tools[0].name },
        };
      } else {
        oaiReq.tool_choice = "auto";
      }
    }
  }

  return oaiReq;
}

export function openaiToAnthropic(
  oaiRes: OpenAIResponse,
  anthropicModel: string
): AnthropicResponse {
  const choice = oaiRes.choices[0];
  const content: AnthropicContentBlock[] = [];

  if (choice.message.content) {
    const text = Array.isArray(choice.message.content)
      ? choice.message.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n")
      : choice.message.content;
    content.push({ type: "text", text });
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  const stopReasonMap: Record<string, "end_turn" | "max_tokens" | "stop_sequence" | "tool_use"> = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
  };

  return {
    id: oaiRes.id,
    type: "message",
    role: "assistant",
    content,
    model: anthropicModel,
    stop_reason: stopReasonMap[choice.finish_reason || ""] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: oaiRes.usage?.prompt_tokens || 0,
      output_tokens: oaiRes.usage?.completion_tokens || 0,
    },
  };
}

export function openaiChunkToAnthropicEvents(
  chunk: OpenAIStreamChunk,
  anthropicModel: string,
  state: StreamState
): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [];
  const delta = chunk.choices[0]?.delta;
  const finishReason = chunk.choices[0]?.finish_reason;

  if (!state.messageStarted) {
    state.messageStarted = true;
    state.messageId = chunk.id;
    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        model: anthropicModel,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.id && !state.toolCallStarted[tc.id]) {
        state.toolCallStarted[tc.id] = true;
        state.contentIndex++;
        events.push({
          type: "content_block_start",
          index: state.contentIndex,
          content_block: {
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name || "",
            input: {},
          },
        });
      }
      if (tc.function?.arguments) {
        events.push({
          type: "content_block_delta",
          index: state.contentIndex,
          delta: {
            type: "input_json_delta",
            partial_json: tc.function.arguments,
          } as AnthropicInputJSONDelta,
        });
      }
    }
  }

  if (delta?.content) {
    if (!state.textBlockStarted) {
      state.textBlockStarted = true;
      state.contentIndex++;
      events.push({
        type: "content_block_start",
        index: state.contentIndex,
        content_block: { type: "text", text: "" },
      });
    }
    events.push({
      type: "content_block_delta",
      index: state.contentIndex,
      delta: { type: "text_delta", text: delta.content } as AnthropicTextDelta,
    });
  }

  if (finishReason) {
    if (state.textBlockStarted) {
      events.push({ type: "content_block_stop", index: state.contentIndex });
    }
    for (const tcId of Object.keys(state.toolCallStarted)) {
      events.push({ type: "content_block_stop", index: state.contentIndex });
    }
    events.push({
      type: "message_delta",
      delta: {
        stop_reason: finishReason === "stop" ? "end_turn" : finishReason === "length" ? "max_tokens" : "tool_use",
        stop_sequence: null,
      },
      usage: { output_tokens: 0 },
    });
    events.push({ type: "message_stop" });
  }

  return events;
}

export interface StreamState {
  messageStarted: boolean;
  messageId: string;
  contentIndex: number;
  textBlockStarted: boolean;
  toolCallStarted: Record<string, boolean>;
}

export function createStreamState(): StreamState {
  return {
    messageStarted: false,
    messageId: "",
    contentIndex: -1,
    textBlockStarted: false,
    toolCallStarted: {},
  };
}
