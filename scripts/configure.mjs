import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function parseKeyDocument(text) {
  // 单独解析 MiniMax 区块，避免把第二个 sk- 密钥误判为千问。
  const miniSection = text.match(/^\s*minimax\s*\r?\n([\s\S]*?)(?=^\s*(?:QWEN_API_KEY|TAVILY_API_KEY|qwen|千问|tavily(?:api)?)\b|(?![\s\S]))/im)?.[0] ?? '';
  const miniInline = [...text.matchAll(/^\s*MINIMAX_API_KEY\s*[:=：]\s*["']?([^\s"']+)/gim)].map(match => match[1]);
  const miniBlock = [...miniSection.matchAll(/(?:^|\n)\s*(?:key|密钥)\s*[:=：]?\s*["']?([A-Za-z0-9_.-]+)/gi)].map(match => match[1]);
  const miniKeys = [...new Set([...miniInline, ...miniBlock])];
  if (miniKeys.length > 1) throw new Error('key.txt 中 MiniMax 存在多个密钥，请明确唯一配置。');
  text = text.replace(miniSection, '').replace(/^\s*MINIMAX_API_KEY\s*[:=：].*$/gim, '');
  const tavily = [...new Set(text.match(/\btvly-[A-Za-z0-9_-]+/g) ?? [])];
  const qwen = [...new Set(text.match(/\bsk-[A-Za-z0-9_.-]+/g) ?? [])];
  if (tavily.length > 1 || qwen.length > 1) throw new Error('key.txt 中同一服务存在多个密钥，请明确唯一的服务配置。');
  /** @type {{ TAVILY_API_KEY: string | undefined, QWEN_API_KEY: string | undefined, MINIMAX_API_KEY?: string }} */
  const result = { TAVILY_API_KEY: tavily[0], QWEN_API_KEY: qwen[0] };
  for (const [name, label] of [['TAVILY_API_KEY', 'TAVILY_API_KEY|tavily'], ['QWEN_API_KEY', 'QWEN_API_KEY|qwen|千问']]) {
    const match = text.match(new RegExp(`(?:${label})[^\r\n:=：]{0,25}[:=：]\\s*["']?([^\\s"']+)`, 'i'));
    if (!result[name] && match) result[name] = match[1];
  }
  if (miniKeys[0]) result.MINIMAX_API_KEY = miniKeys[0];
  return result;
}
export async function configure() {
  let env = await readFile('.env.local', 'utf8').catch(() => '');
  const document = await readFile('key.txt', 'utf8').catch(() => '');
  const credentials = parseKeyDocument(document);
  const defaults = { QWEN_BASE_URL: 'https://maas.qianwenaiapi.com/compatible-mode/v1', QWEN_MODEL: 'qwen3.8-flash', TAVILY_BASE_URL: 'https://api.tavily.com', TAVILY_TIMEOUT_MS: '60000', X_TARGET_LENGTH: '280', MINIMAX_BASE_URL: 'https://api.minimax.cn/v1', MINIMAX_TIMEOUT_MS: '120000' };
  for (const [name, value] of Object.entries({ ...defaults, ...credentials })) {
    const pattern = new RegExp(`^${name}=(.*)$`, 'm');
    const current = env.match(pattern)?.[1]?.trim();
    if ((!current || /^(your-|填写|自己的)/.test(current)) && value) {
      env = pattern.test(env) ? env.replace(pattern, () => `${name}=${value}`) : `${env.trimEnd()}\n${name}=${value}\n`;
    }
  }
  const missing = ['QWEN_API_KEY', 'TAVILY_API_KEY', 'MINIMAX_API_KEY'].filter(name => !new RegExp(`^${name}=(?!your-|填写|自己的)\\S+`, 'm').test(env));
  if (missing.length) throw new Error(`请在 .env.local 或标明服务归属的 key.txt 中配置：${missing.join('、')}。`);
  await writeFile('.env.local', env.trimStart(), { mode: 0o600 });
  console.log('千问、Tavily 与 MiniMax 后端配置已就绪（未输出密钥）。');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configure().catch(error => { console.error(error.message); process.exitCode = 1; });
}
