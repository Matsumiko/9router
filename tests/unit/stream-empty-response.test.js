import { describe, expect, it } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

async function completeStream(payload, callback) {
  const stream = createPassthroughStreamWithLogger("test", null, "model", null, {}, callback);
  const reader = stream.readable.getReader();
  const drain = (async () => {
    while (!(await reader.read()).done) {}
  })();
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(payload));
  await writer.close();
  await drain;
}

describe("stream completion output validation", () => {
  it("marks a finish-only stream as non-meaningful", async () => {
    let completion;
    await completeStream(
      'data: {"id":"chatcmpl-test","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      (content, usage, ttft, meta) => { completion = { content, meta }; },
    );

    expect(completion.meta).toEqual({ meaningful: false });
    expect(completion.content).toEqual({ content: "", thinking: "" });
  });

  it("marks text and tool-call streams as meaningful", async () => {
    let textCompletion;
    await completeStream(
      'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
      (content, usage, ttft, meta) => { textCompletion = meta; },
    );
    expect(textCompletion).toEqual({ meaningful: true });

    let toolCompletion;
    await completeStream(
      'data: {"id":"chatcmpl-test","choices":[{"delta":{"tool_calls":[{"id":"call_1"}]},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
      (content, usage, ttft, meta) => { toolCompletion = meta; },
    );
    expect(toolCompletion).toEqual({ meaningful: true });
  });
});
