// 只提取根对象指定数组内已闭合的对象。完整 JSON 仍由业务服务最终解析。
// 逐字符维护字符串转义和嵌套边界，不依赖字段顺序或网络块边界。
export function modelObjectArrayReader(field: "summary" | "paragraphs", onBlock: (raw: unknown, index: number) => Promise<void>) {
  let text = "", offset = 0, stringStart = -1, escaped = false;
  let rootKey = "", expectKey = true, keyString = false;
  let summary = false, seenSummary = false, blockStart = -1, index = 0;
  const stack: string[] = [];
  return async (delta: string) => {
    text += delta;
    for (; offset < text.length; offset++) {
      const char = text[offset];
      if (stringStart >= 0) {
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char === '"') {
          if (keyString) { rootKey = JSON.parse(text.slice(stringStart, offset + 1)); expectKey = false; }
          stringStart = -1;
        }
        continue;
      }
      if (!stack.length && char !== "{") continue;
      if (summary && stack.length === 2 && !/[\s,{\]]/.test(char))
        throw new Error(`${field}中的段落必须为对象`);
      if (char === '"') {
        stringStart = offset; escaped = false;
        keyString = stack.length === 1 && expectKey;
      } else if (char === "{" || char === "[") {
        if (char === "[" && stack.length === 1 && rootKey === field) {
          if (seenSummary) throw new Error(`模型包含重复${field}字段`);
          summary = seenSummary = true;
        }
        if (summary && stack.length === 2 && char === "{") blockStart = offset;
        stack.push(char);
      } else if (char === "}" || char === "]") {
        if (stack.at(-1) !== (char === "}" ? "{" : "[")) throw new Error("报告JSON边界无效");
        if (summary && stack.length === 3 && char === "}" && blockStart >= 0) {
          const raw = JSON.parse(text.slice(blockStart, offset + 1));
          blockStart = -1;
          await onBlock(raw, index++);
        }
        if (summary && stack.length === 2 && char === "]") summary = false;
        stack.pop();
      } else if (char === "," && stack.length === 1) {
        expectKey = true; rootKey = "";
      }
    }
  };
}
