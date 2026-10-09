// SSE 的传输分帧与 UTF-8 解码共用；业务事件由各自读取器检查。
export async function readEventStream(response: Response, onEvent: (event: unknown) => void) {
  if (!response.body) throw new Error("未收到流式数据，请重试。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", ended = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let event: unknown;
        try { event = JSON.parse(data); }
        catch { throw new Error("流式数据格式异常，请重试。"); }
        onEvent(event);
      }
      if (done) { ended = true; break; }
    }
    if (buffer.trim()) throw new Error("连接中断，分析未完整完成，请重试。");
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
