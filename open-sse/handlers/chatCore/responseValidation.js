function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasGeminiPartContent(part) {
  return hasText(part?.text) || Boolean(part?.functionCall || part?.function_call || part?.inlineData || part?.inline_data);
}

export function hasMeaningfulChatResponse(response) {
  if (!response || typeof response !== "object") return false;

  const choices = Array.isArray(response.choices) ? response.choices : [];
  if (choices.length > 0) {
    return choices.some((choice) => {
      const message = choice?.message || choice?.delta || {};
      return hasText(message.content)
        || hasText(message.reasoning_content)
        || hasText(message.reasoning)
        || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
        || (Array.isArray(message.content) && message.content.some((part) => hasText(part?.text) || part?.type === "tool_use" || part?.type === "thinking"));
    });
  }

  if (Array.isArray(response.output) && response.output.length > 0) {
    return response.output.some((item) => {
      if (item?.type === "message") {
        return Array.isArray(item.content) && item.content.some((part) => hasText(part?.text));
      }
      return item?.type === "function_call" || item?.type === "custom_tool_call" || item?.type === "reasoning";
    });
  }

  const candidates = response.candidates || response.response?.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    return candidates.some((candidate) => Array.isArray(candidate?.content?.parts) && candidate.content.parts.some(hasGeminiPartContent));
  }

  if (Array.isArray(response.content)) {
    return response.content.some((part) => hasText(part?.text) || part?.type === "tool_use" || part?.type === "thinking");
  }

  return hasText(response.content) || hasText(response.text) || hasText(response.reasoning_content);
}

export function emptyChatResponseMessage(provider) {
  return `${provider || "Provider"} returned HTTP 200 without text, reasoning, tool calls, or response output`;
}
