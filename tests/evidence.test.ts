import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl } from '../src/core/sources';
import { validateReport } from '../src/core/evidence';
import { draftSchema, type Source } from '../src/core/contracts';
import { evidenceRegistry, hydrateReferences } from '../src/core/evidence';
const url = "https://hai.stanford.edu/report";
const evidence = "In 2024, 71% of survey respondents reported using generative AI in at least one business function.";
const sources: Source[] = [{ id: "S1", url, title: null, publishedAt: null, sourceType: "机构报告", extractedContent: evidence, extractionStatus:"available", extractionReason:"已取得正文" }];
function draft() { return draftSchema.parse({ title: "企业生成式 AI 使用情况", summary: [{ text: "调查受访者报告了生成式 AI 使用情况。", references: [{sourceId:"S1",quote:evidence}] }], cards:[{label:"受访者报告的使用比例",value:"71",unit:"%",explanation:"这是调查受访者的回答，不代表所有企业。",period:"2024",scope:"调查受访者，至少一个业务环节",valueEvidence:"71",unitEvidence:"%",timeEvidence:"2024",scopeEvidence:"survey respondents",references:[{sourceId:"S1",quote:evidence}]}],limitations:[] }); }
test("valid card survives whitespace normalization", () => { const d = draft(); d.cards[0].references[0].quote = evidence.replaceAll(" ", "\n"); assert.equal(validateReport(d,sources).report.cards.length,1); });
test("unknown source id rejected", () => { const d = draft(); d.cards[0].references[0].sourceId="S99"; assert.equal(validateReport(d,sources).report.cards.length,0); });
test("link without extracted evidence cannot support a card or summary", () => { const empty=sources.map(s=>({...s,extractedContent:""})); const r=validateReport(draft(),empty);assert.equal(r.report.cards.length,0);assert.equal(r.report.summary.length,0); });
test("invented quote rejected", () => { const d=draft();d.cards[0].references[0].quote="In 2024, 92% of all enterprises use AI.";assert.equal(validateReport(d,sources).report.cards.length,0); });
test("unsupported numerical explanation rejected", () => { const d=draft();d.cards[0].explanation="覆盖 9000 家企业。"; assert.equal(validateReport(d,sources).report.cards.length,0); });
test("changed headline value rejected", () => { const d=draft();d.cards[0].value="91"; assert.equal(validateReport(d,sources).report.cards.length,0); });
test("unit elsewhere in quote cannot be attached to a different number", () => { const d=draft();d.cards[0].value="2024";d.cards[0].valueEvidence="2024";assert.equal(validateReport(d,sources).report.cards.length,0); });
test("period must agree with the original time anchor", () => { const d=draft();d.cards[0].period="2023";assert.equal(validateReport(d,sources).report.cards.length,0); });
test("unsafe URLs rejected and tracking URLs deduplicated",()=>{assert.equal(canonicalUrl("javascript:alert(1)"),null);assert.equal(canonicalUrl("http://127.0.0.1/test"),null);assert.equal(canonicalUrl(`${url}?utm_source=x#section`),url);});
test("evidence IDs map to original source text and ignore model-written quotes",()=>{
  const records=evidenceRegistry(sources);const input={summary:[],cards:[{references:[{sourceId:"S1",evidenceId:records[0].id,quote:"forged text"}]}]};
  const hydrated=hydrateReferences(input,records) as {cards:{references:{quote:string}[]}[]};assert.equal(hydrated.cards[0].references[0].quote,evidence);
});
test("evidence cannot be reassigned to another source or invented",()=>{
  const records=evidenceRegistry(sources);
  assert.throws(()=>hydrateReferences({summary:[],cards:[{references:[{sourceId:"S99",evidenceId:records[0].id}]}]},records),/unknown evidence/);
  assert.throws(()=>hydrateReferences({summary:[],cards:[{references:[{sourceId:"S1",evidenceId:"S1-E999"}]}]},records),/unknown evidence/);
});
