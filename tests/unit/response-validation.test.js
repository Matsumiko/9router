import { describe, expect, it } from "vitest";
import { hasMeaningfulChatResponse } from "../../open-sse/handlers/chatCore/responseValidation.js";

describe("chat response validation", () => {
  it("rejects HTTP 200-shaped empty chat completions", () => {
    expect(hasMeaningfulChatResponse({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] })).toBe(false);
    expect(hasMeaningfulChatResponse({ choices: [] })).toBe(false);
    expect(hasMeaningfulChatResponse({})).toBe(false);
  });

  it.each([
    ["text", { choices: [{ message: { content: "hello" } }] }],
    ["reasoning", { choices: [{ message: { reasoning_content: "thinking" } }] }],
    ["tool call", { choices: [{ message: { tool_calls: [{ id: "call_1" }] } }] }],
    ["Responses output", { output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }] }],
    ["Responses function call", { output: [{ type: "function_call", name: "lookup" }] }],
    ["Gemini part", { candidates: [{ content: { parts: [{ text: "hello" }] } }] }],
  ])("accepts meaningful %s responses", (_label, response) => {
    expect(hasMeaningfulChatResponse(response)).toBe(true);
  });
});
