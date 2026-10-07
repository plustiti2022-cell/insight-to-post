import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function parseKeyDocument(text) {
  const tavily = [...new Set(text.match(/\btvly-[A-Za-z0-9_-]+/g) ?? [])];
  const qwen = [...new Set(text.match(/\bsk-[A-Za-z0-9_.-]+/g) ?? [])];
  if (tavily.length > 1 || qwen.length > 1) throw new Error('key.txt 中同一服务存在多个密钥，请明确唯一的服务配置。');
  const result = { TAVILY_API_KEY: tavily[0], QWEN_API_KEY: qwen[0] };
  for (const [name, label] of [['TAVILY_API_KEY', 'TAVILY_API_KEY|tavily'], ['QWEN_API_KEY', 'QWEN_API_KEY|qwen|千问']]) {
    const match = text.match(new RegExp(`(?:${label})[^\r\n:=：]{0,25}[:=：]\\s*["']?([^\\s"']+)`, 'i'));
    if (!result[name] && match) result[name] = match[1];
  }
  return result;
}
export async function configure() {
  let env = await readFile('.env.local', 'utf8').catch(() => '');
  const document = await readFile('key.txt', 'utf8').catch(() => '');
  const credentials = parseKeyDocument(document);
  const defaults = { QWEN_BASE_URL: 'https://maas.qianwenaiapi.com/compatible-mode/v1', QWEN_MODEL: 'qwen3.8-flash', TAVILY_BASE_URL: 'https://api.tavily.com', TAVILY_TIMEOUT_MS: '60000', X_TARGET_LENGTH: '280' };
  for (const [name, value] of Object.entries({ ...defaults, ...credentials })) {
    const pattern = new RegExp(`^${name}=(.*)$`, 'm');
    const current = env.match(pattern)?.[1]?.trim();
    if ((!current || /^(your-|填写|自己的)/.test(current)) && value) {
      env = pattern.test(env) ? env.replace(pattern, () => `${name}=${value}`) : `${env.trimEnd()}\n${name}=${value}\n`;
    }
  }
  const missing = ['QWEN_API_KEY', 'TAVILY_API_KEY'].filter(name => !new RegExp(`^${name}=\\S+`, 'm').test(env));
  if (missing.length) throw new Error(`请在 .env.local 或标明服务归属的 key.txt 中配置：${missing.join('、')}。`);
  await writeFile('.env.local', env.trimStart(), { mode: 0o600 });
  console.log('千问与 Tavily 后端配置已就绪（未输出密钥）。');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configure().catch(error => { console.error(error.message); process.exitCode = 1; });
}
