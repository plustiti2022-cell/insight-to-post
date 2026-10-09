// 模型只负责提取与设计；这里检查可解码的数据和静态 SVG 的展示边界。
export function readDataObservations(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim()))
    throw new Error("数据提取未返回有效的 JSON 文案数组。");
  // 去掉完全重复的条目；数字政策同时覆盖中文数词。
  const items = value.map(item => (item as string).trim());
  if (items.some(text => !/[0-9０-９零〇一二三四五六七八九十百千万亿两]/.test(text)))
    throw new Error("数据提取返回了不包含数字的条目。");
  return [...new Set(items)];
}

const elements = new Set(["svg", "g", "defs", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "linearGradient", "radialGradient", "stop", "title", "desc"]);
const attributes = new Set([
  "xmlns", "width", "height", "viewBox", "id", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "dx", "dy",
  "d", "points", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset",
  "opacity", "transform", "font-family", "font-size", "font-weight", "letter-spacing", "text-anchor", "dominant-baseline", "alignment-baseline", "textLength", "lengthAdjust",
  "gradientUnits", "gradientTransform", "offset", "stop-color", "stop-opacity", "fx", "fy", "spreadMethod",
]);
function validEntities(value: string) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#(?:[0-9]+|x[0-9a-fA-F]+);)/.test(value)) return false;
  return [...value.matchAll(/&#(x[0-9a-fA-F]+|[0-9]+);/g)].every(([, code]) => {
    const point = code.startsWith("x") ? parseInt(code.slice(1), 16) : Number(code);
    return [9, 10, 13].includes(point) || point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) && ![0xfffe, 0xffff].includes(point);
  });
}

// 白名单解析完整标签、引号属性和闭合栈，拒绝外链、执行能力与无效 XML。
// 展示时仍通过 img 隔离 SVG，不将模型标记插入页面 DOM。
export function readStaticPosterSvg(raw: string): string {
  let svg = raw.trim();
  const invalid = (reason = "标签、属性或闭合结构错误") => { throw new Error(`静态 SVG 无法展示：${reason}。`); };
  if (!svg || svg.length > 300000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg)) invalid();
  const stack: string[] = [];
  let position = 0, rootPosition = 0, rootSeen = false, rootClosed = false, namespace = false, background = false;
  while (position < svg.length) {
    if (svg[position] !== "<") {
      const end = svg.indexOf("<", position);
      const text = svg.slice(position, end < 0 ? svg.length : end);
      if (!validEntities(text) || text.includes("]]>") || (text.trim() && !["text", "tspan", "title", "desc"].includes(stack.at(-1) ?? ""))) invalid();
      position = end < 0 ? svg.length : end;
      continue;
    }
    if (svg.startsWith("<!--", position)) {
      const end = svg.indexOf("-->", position + 4);
      if (end < 0 || svg.slice(position + 4, end).includes("--")) invalid();
      position = end + 3;
      continue;
    }
    const token = /^<\/?[A-Za-z][A-Za-z0-9]*(?:\s+(?:[^<>"']|"[^"<>]*"|'[^'<>]*')*)?\s*\/?>/.exec(svg.slice(position))?.[0];
    if (!token) invalid();
    const tag = token!;
    position += tag.length;
    const name = /^<\/?([A-Za-z][A-Za-z0-9]*)/.exec(tag)![1];
    if (!elements.has(name)) invalid(`包含不允许的 ${name.slice(0, 40)} 标签`);
    if (tag.startsWith("</")) {
      if (!new RegExp(`^</${name}\\s*>$`).test(tag) || stack.pop() !== name) invalid();
      if (name === "svg") rootClosed = true;
      continue;
    }
    if (rootClosed || (!rootSeen && name !== "svg") || (rootSeen && name === "svg")) invalid();
    const rest = tag.slice(name.length + 1).replace(/\/?\s*>$/, "");
    const attrs: Record<string, string> = {};
    let cursor = 0;
    while (cursor < rest.length) {
      if (!rest.slice(cursor).trim()) break;
      const match = /^\s+([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest.slice(cursor));
      if (!match) invalid();
      const [, key, double, single] = match!;
      const value = double ?? single;
      if (!attributes.has(key)) invalid(`包含不允许的 ${key.slice(0, 40)} 属性`);
      if (Object.hasOwn(attrs, key) || !validEntities(value)) invalid();
      // 属性中的实体可能伪装 URL / CSS，只允许文字节点使用实体。
      if (value.includes("&") || /(?:https?:|data:|javascript:|\/\/|\\|[<>])/i.test(value) && key !== "xmlns") invalid("属性包含外链或不允许的内容");
      if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z][\w-]*\)$/.test(value)) invalid("包含非本地的资源引用");
      if (key === "xmlns" && (name !== "svg" || value !== "http://www.w3.org/2000/svg")) invalid();
      if (key === "font-family" && value.replace(/['"]/g, "").replace(/\s*,\s*/g, ",").trim() !== "Arial,Microsoft YaHei,sans-serif") invalid("字体必须使用 Arial, Microsoft YaHei, sans-serif");
      attrs[key] = value;
      cursor += match![0].length;
    }
    if (!rootSeen) {
      if (attrs.width !== "768" || attrs.height !== "1024" || attrs.viewBox?.trim().replace(/\s+/g, " ") !== "0 0 768 1024" || tag.endsWith("/>")) invalid("画布必须为 768 × 1024，viewBox 为 0 0 768 1024");
      if (attrs.opacity && Number(attrs.opacity) !== 1 || attrs["fill-opacity"] && Number(attrs["fill-opacity"]) !== 1 || attrs.transform) invalid("画布不得透明或整体变换");
      namespace = Boolean(attrs.xmlns);
      rootPosition = position - tag.length;
      rootSeen = true;
    }
    if (name === "rect" && stack.length === 1 && !background) {
      const fill = attrs.fill ?? "";
      background = (attrs.x === undefined || Number(attrs.x) === 0) && (attrs.y === undefined || Number(attrs.y) === 0)
        && ["768", "100%"].includes(attrs.width) && ["1024", "100%"].includes(attrs.height) && !attrs.rx && !attrs.ry && !attrs.transform
        && (!attrs.opacity || Number(attrs.opacity) === 1) && (!attrs["fill-opacity"] || Number(attrs["fill-opacity"]) === 1)
        && (/^#[0-9a-f]{6}$/i.test(fill) || /^#[0-9a-f]{3}$/i.test(fill) || /^(?:black|white|navy|midnightblue)$/i.test(fill));
    }
    if (!tag.endsWith("/>")) stack.push(name);
  }
  if (!rootSeen || !rootClosed || stack.length) invalid();
  if (!background) invalid("缺少覆盖完整画布的不透明背景矩形");
  if (!namespace) svg = svg.slice(0, rootPosition) + svg.slice(rootPosition).replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}
