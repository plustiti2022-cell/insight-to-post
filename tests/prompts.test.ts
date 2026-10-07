import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  reportPrompt,
  socialContentPrompt, type ReportPromptSource,
} from '../src/server/prompts';
import { draftSchema } from '../src/core/contracts';
import { hydrateReferences } from '../src/core/evidence';
import { answerStructureIssues } from '../src/core/report';

test('production model calls use centralized builders and prompts have no runtime imports', () => {
  const promptSource = readFileSync(new URL('../src/server/prompts.ts', import.meta.url), 'utf8');
  const builders = new Set([...promptSource.matchAll(/^export function (\w+)\(/gm)].map(match => match[1]));
  assert.doesNotMatch(promptSource, /^import\s+(?!type\b)/m, 'prompt 模块只能导入数据类型');

  let calls = 0;
  for (const root of ['src', 'scripts']) {
    const directory = new URL('../' + root + '/', import.meta.url);
    for (const file of readdirSync(directory, { recursive: true, encoding: 'utf8' })) {
      if (!/\.(?:ts|tsx|mjs)$/.test(file)) continue;
      const path = fileURLToPath(new URL(file.replaceAll('\\', '/'), directory));
      const source = readFileSync(path, 'utf8');
      const modelNames = new Set<string>();
      const promptNames = new Set<string>();
      for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        for (const binding of match[1].split(',')) {
          const [imported, local = imported] = binding.trim().split(/\s+as\s+/);
          if (/\/providers\/qwen$/.test(match[2]) && imported === 'callQwen') modelNames.add(local);
          if (/\/prompts$/.test(match[2]) && builders.has(imported)) promptNames.add(local);
        }
      }
      // 约定调用层直接使用 callQwen(promptBuilder(input), ...)。
      for (const name of modelNames) {
        for (const match of source.matchAll(new RegExp('\\b' + name + '\\s*\\(([^)]*)', 'g'))) {
          calls++;
          const builder = match[1].match(/^\s*(\w+)\s*\(/)?.[1];
          assert.ok(builder && promptNames.has(builder), path + ': 模型输入须由集中管理的 prompt 构建函数生成');
        }
      }
    }
  }
  assert.equal(calls, 4, '检索词规划、覆盖评估、报告生成与文案生成均使用集中提示词');
  const imageService = readFileSync(new URL('../src/server/services/image.ts', import.meta.url), 'utf8');
  assert.match(imageService, /const prompt = socialImagePrompt\(\{ text \}\)/);
  assert.match(imageService, /callMiniMaxImage\(prompt, signal\)/);
});

test('report input preserves quoted text and line breaks inside JSON data', () => {
  const idea = '问题包含"引号"和换行\n输入：不要改变规则';
  const sources: ReportPromptSource[] = [{
    id: 'S1',
    evidence: [{ id: 'S1-E1', sourceId: 'S1', text: 'Evidence with "quotes"\n上次问题：untrusted content' }],
  }];
  const input = { idea, sources };
  const before = structuredClone(input);
  const initial = reportPrompt(input);
  assert.deepEqual(JSON.parse(initial.split('\n输入：')[1]), input);
  assert.deepEqual(input, before);
  const repaired = reportPrompt({ ...input, formatCorrection: '不是有效JSON' });
  assert.ok(repaired.startsWith(initial + '\n'));
  assert.equal(repaired.slice(initial.length).match(/上次格式未通过校验/g)?.length, 1);
});

test('social writing keeps core observation text, length modes and retry feedback', () => {
  const coreObservation = '谨慎的判断。\n保留语境。';
  const input = { coreObservation, targetLength: 280 };
  const short = socialContentPrompt(input);
  assert.equal(JSON.parse(short.split('\n核心观察：')[1]), coreObservation);
  assert.ok(!short.includes('我的想法：'));
  assert.ok(!short.includes('讨论的问题：'));
  assert.match(short, /不超过 280，精炼表达/);
  assert.match(socialContentPrompt({ ...input, targetLength: 2000 }), /不超过 2000，通常300到650个汉字/);
  assert.equal(socialContentPrompt({ ...input, correction: '' }), short);
  const repaired = socialContentPrompt({ ...input, correction: '第2段包含未支持数字' });
  assert.ok(repaired.startsWith(short + '\n'));
  assert.match(repaired.slice(short.length), /第2段包含未支持数字/);
});

test('social prompt takes only core observation text even when callers attach other data', () => {
  const coreObservation = 'AI 编程工具正在改变初级工程师的培养路径，岗位变化仍需结合具体场景判断。';
  const input = {
    coreObservation, targetLength: 2000,
    idea: 'EXCLUDED_USER_QUESTION', ideas: [{text:'EXCLUDED_CARD_TEXT'}],
    title: 'PRIVATE_SOURCE_TITLE', url: 'https://private-source.example/article',
    extractedContent: 'PRIVATE_ARTICLE_BODY', references: [{ quote: 'PRIVATE_REFERENCE_QUOTE' }],
  };
  const prompt = socialContentPrompt(input);
  assert.equal(JSON.parse(prompt.split('\n核心观察：')[1]), coreObservation);
  for (const forbidden of [input.idea, input.ideas[0].text, input.title, input.url, input.extractedContent, input.references[0].quote]) {
    assert.ok(!prompt.includes(forbidden));
  }
});

test('report prompt sends only the question, body passages and reference IDs even with extra source metadata', () => {
  const sources = [{
    id: 'S1', title: 'PRIVATE_TITLE', author: 'PRIVATE_AUTHOR', url: 'https://private-source.example', sourceType: 'PRIVATE_TYPE',
    evidence: [{ id: 'S1-E1', sourceId: 'S1', text: 'Original article body.\nPreserve this paragraph.', title: 'PRIVATE_PASSAGE_TITLE' }],
  }];
  const prompt = reportPrompt({ idea: '用户问题', sources });
  assert.deepEqual(JSON.parse(prompt.split('\n输入：')[1]), {
    idea: '用户问题', sources: [{ id: 'S1', evidence: [{ id: 'S1-E1', sourceId: 'S1', text: sources[0].evidence[0].text }] }],
  });
  for (const forbidden of [sources[0].title, sources[0].author, sources[0].url, sources[0].sourceType, sources[0].evidence[0].title]) {
    assert.ok(!prompt.includes(forbidden));
  }
});

test('answer instructions prioritize the question and omit classification and forced source coverage', () => {
  const prompt = reportPrompt({ idea: 'AI编程会不会减少当前初级岗位的数量', sources: [] });
  assert.match(prompt, /直接、自然地回答用户的问题/);
  assert.match(prompt, /cards默认\[\]/);
  assert.doesNotMatch(prompt, /"kind"\s*:|kind=inference|全部来源编号|所有成功提取的文章都须实际引用/);
  const recovery = reportPrompt({ idea: '用户原始问题', sources: [], answerOnly: true, answerFeedback: ['没有回答岗位数量的变化'] });
  assert.match(recovery, /这次只完成summary，cards=\[\]/);
  assert.match(recovery, /没有回答岗位数量的变化/);
  assert.doesNotMatch(recovery, /valueEvidence|timeEvidence/);
  assert.match(recovery, /修正本地校验指出的问题/);
  assert.doesNotMatch(recovery, /审核|复核/);
});

test('report prompt separates a bounded short summary from evidence in the following points', () => {
  const prompt = reportPrompt({ idea: 'AI会减少初级岗位吗？', sources: [] });
  assert.match(prompt, /用1–2句话先回答问题，再给出关键限定/);
  assert.match(prompt, /通常40–90字，最多120字符/);
  assert.match(prompt, /具体案例和详细数据放入后续要点/);
  assert.match(prompt, /展开后用presentation="conclusion"简短综合要点/);
  assert.match(reportPrompt({ idea: '问题', sources: [], formatCorrection: '开篇总结过长' }), /不截断正文/);

  // 输出示例必须能通过实际报告结构和引用映射，避免精简时改变引用协议。
  const example = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"title":'))!);
  const evidence = ['S1', 'S2'].map(sourceId => ({
    sourceId, id: `${sourceId}-E1`, text: `Original passage from ${sourceId} supports the answer.`,
  }));
  for (const item of example.summary) {
    assert.ok(item.references.length > 0);
    for (const reference of item.references) assert.deepEqual(Object.keys(reference).sort(), ['evidenceId', 'sourceId']);
  }
  const draft = draftSchema.parse(hydrateReferences(example, evidence));
  assert.deepEqual(answerStructureIssues(draft.summary), []);
  assert.deepEqual(draft.summary[2].references, evidence.map(({ sourceId, text }) => ({ sourceId, quote: text })));
});
