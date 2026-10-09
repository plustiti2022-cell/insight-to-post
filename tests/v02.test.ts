import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeyDocument } from '../scripts/configure.mjs';
import { callTavily } from '../src/server/providers/tavily';
import { applyContent, mergeResults, researchWithTavily } from '../src/server/services/research';
import { countCoverage, reportCoverage, assignClaimIds } from '../src/core/sources';
import { validateSocialDraft, normalizeSocialText } from '../src/core/social';
import { generateSocialContent } from '../src/server/services/social';
import { signSocialSnapshot, readSocialSnapshot } from '../src/server/services/snapshot';
import { analyze } from '../src/server/workflow/run';
import { generateReport } from '../src/server/services/report';
import { evidenceRegistry } from '../src/core/evidence';
import type { Draft, Source } from '../src/core/contracts';
import { includeEveryArticle } from '../src/core/report';
import { readSocialForDisplay } from '../src/core/social';
import { eligibleForGeneration } from '../src/core/sources';

const facts = ['A controlled trial measured coding task completion under fixed experimental conditions.', 'The research group tested model training procedures and reported boundaries of the evaluation.', 'Researchers explored architecture optimization with human review of the proposed candidates.', 'The institutional report discussed deployment monitoring and the need for repeated validation.', 'A separate institutional report described human decisions about objectives and constraints.'];
const sources: Source[] = facts.map((fact,i) => ({ id:`S${i+1}`, url:`https://${i<3?'arxiv.org':'metr.org'}/unique-${i}`, title:`Distinct research source ${i+1}`, sourceType:i<3?'研究论文':'机构报告', publishedAt:null, extractedContent:`${fact} ${String.fromCharCode(65+i).repeat(150)}`, extractionStatus:'available', extractionReason:'test' }));
const report: Draft = assignClaimIds({ title:'test', cards:[], summary:[{text:'实验评估各有边界。',references:sources.slice(0,3).map(s=>({sourceId:s.id,quote:s.extractedContent}))},{text:'研究中的人仍要设定目标并做出判断。',references:sources.slice(3).map(s=>({sourceId:s.id,quote:s.extractedContent}))}],limitations:[] });
const socialRaw = { paragraphs:[{text:'AI研究中的变化，值得我们认真看一眼。',claimIds:[]},{text:'实验评估各有边界，目标设定和判断仍离不开人。',claimIds:['summary-1','summary-2']},{text:'如果进入你的工作，你最想保留哪部分判断？',claimIds:[]}] };
const restore = (names: string[]) => {const saved=names.map(name=>process.env[name]);return ()=>names.forEach((name,i)=>saved[i]===undefined?delete process.env[name]:process.env[name]=saved[i]);};

test('service-specific key import does not confuse a Tavily token with Qwen',()=>{
  assert.deepEqual(parseKeyDocument('QWEN_API_KEY=sk-test\nTAVILY_API_KEY=tvly-test'),{QWEN_API_KEY:'sk-test',TAVILY_API_KEY:'tvly-test'});
  assert.equal(parseKeyDocument('key：sk-provider.token.here').TAVILY_API_KEY,undefined);
  assert.throws(()=>parseKeyDocument('tvly-first tvly-second'));
});
test('coverage requires all extracted articles and does not require five sources or two types',()=>{
  assert.equal(countCoverage(sources,sources.map(s=>s.id)).requirementMet,true);
  assert.equal(countCoverage(sources,sources.slice(0,4).map(s=>s.id)).requirementMet,false);
  assert.equal(reportCoverage({...report,summary:[]},sources).citedSourceCount,0);
  assert.equal(countCoverage(sources.map(s=>({...s,sourceType:'研究论文'})),sources.map(s=>s.id)).requirementMet,true);
});
test('each extracted article is cited, including separate mirror articles; repeated IDs do not inflate counts',()=>{
  const duplicates=[...sources,{...sources[0],id:'S6',url:'https://mirror.example/article',title:'mirror'}];
  assert.equal(countCoverage(duplicates,['S1','S1','S2','S3','S4','S6']).citedSourceCount,5);
  assert.equal(countCoverage(duplicates,duplicates.map(s=>s.id)).citedSourceCount,6);
});
test('separately extracted arXiv and alphaXiv articles remain available for citation',()=>{
  const mirrors=[{...sources[0],url:'https://arxiv.org/abs/2506.13131'},{...sources[1],url:'https://arxiv.org/pdf/2506.13131v2.pdf'},{...sources[2],url:'https://www.alphaxiv.org/abs/2506.13131'}];
  assert.equal(countCoverage(mirrors,mirrors.map(s=>s.id)).citedSourceCount,3);
});
test('Tavily requests raw body; empty body is attempted failure, denial is unusable',()=>{
  const research={sources:[] as Source[],searchCalls:1,extractorCalls:0,credits:0,warnings:[]};
  mergeResults(research,[{url:'https://example.org/a',content:'a search summary is not raw evidence',raw_content:null}]);
  assert.equal(research.sources[0].extractionStatus,'failed');assert.equal(research.sources[0].extractedContent,'');
  applyContent(research.sources[0],'Access Denied '+ 'blocked '.repeat(30));assert.equal(research.sources[0].extractionStatus,'unusable');
  applyContent(research.sources[0],sources[0].extractedContent);applyContent(research.sources[0],null);assert.equal(research.sources[0].extractionStatus,'available');
});
test('Tavily authentication failure does not expose upstream body or credentials',async()=>{
  const undo=restore(['TAVILY_API_KEY']);const original=globalThis.fetch;process.env.TAVILY_API_KEY='test-only';
  globalThis.fetch=async()=>new Response('secret raw body',{status:401});
  try {await assert.rejects(callTavily('search',{}),error=>error instanceof Error&&error.message.includes('Tavily')&&!error.message.includes('secret'));}finally{globalThis.fetch=original;undo();}
});
test('Extract supplements only known URL bodies, preserves per-URL failures and usage',async()=>{
  const undo=restore(['TAVILY_API_KEY']);const original=globalThis.fetch;process.env.TAVILY_API_KEY='test-only';let calls=0;
  globalThis.fetch=async(_url,init)=>{
    calls++;const body=JSON.parse(String(init?.body));
    if(calls===1){assert.equal(body.include_raw_content,'markdown');assert.equal(body.max_results,15);return Response.json({results:[{url:'https://example.org/a',raw_content:null},{url:'https://example.org/b',raw_content:null}],usage:{credits:2}});}
    assert.deepEqual(body.urls,['https://example.org/a','https://example.org/b']);return Response.json({results:[{url:'https://example.org/a',raw_content:sources[0].extractedContent},{url:'https://injected.example/',raw_content:sources[1].extractedContent}],failed_results:[{url:'https://example.org/b'}],usage:{credits:1}});
  };
  try {const r=await researchWithTavily('question');assert.equal(r.sources.length,2);assert.deepEqual(r.sources.map(s=>s.extractionStatus),['available','failed']);assert.equal(r.credits,3);}finally{globalThis.fetch=original;undo();}
});
test('social text has exactly blank paragraph separators and keeps UI metadata out',()=>{
  const checked=validateSocialDraft(socialRaw,report,sources);assert.deepEqual(checked.problems,[]);
  assert.equal(checked.content.text,socialRaw.paragraphs.map(p=>p.text).join('\n\n'));assert.equal(checked.content.coverage.citedSourceCount,5);
  assert.equal(checked.content.text.includes('summary-1'),false);assert.ok(checked.content.claimReferences.every(r=>r.evidenceIds.length));
  assert.equal(normalizeSocialText('  第一段\r\n\r\n\r\n 第二段  '),'第一段\n\n第二段');
});
test('closing punctuation is preserved and never used as an approval gate',()=>{
  for(const ending of ['当这种变化进入你的工作，你最想保留哪部分判断','当这种变化进入你的工作，你最想保留哪部分判断。','“当这种变化进入你的工作，你最想保留哪部分判断？”']) {
    const candidate={...socialRaw,paragraphs:[...socialRaw.paragraphs.slice(0,-1),{text:ending,claimIds:[]}]};
    const checked=validateSocialDraft(candidate,report,sources);
    assert.deepEqual(checked.problems,[]);
    assert.equal(checked.content.text.split('\n\n').at(-1),ending);
  }
});
test('reflective and declarative endings do not fail a question-style rule',()=>{
  for(const ending of ['人仍需要保留自己的判断。','你怎么看？','你最想保留哪部分判断？研究还在继续。']) {
    const checked=validateSocialDraft({...socialRaw,paragraphs:[...socialRaw.paragraphs.slice(0,-1),{text:ending,claimIds:[]}]},report,sources);
    assert.deepEqual(checked.problems,[]);
    assert.equal(checked.content.text.split('\n\n').at(-1),ending);
  }
});
test('a valid social draft returns after one model call, preserving punctuation and usage',async()=>{
  const undo=restore(['QWEN_API_KEY']);const original=globalThis.fetch;process.env.QWEN_API_KEY='test-only';let calls=0;
  const candidate={...socialRaw,paragraphs:socialRaw.paragraphs.map((p,i)=>i===2?{...p,text:p.text.replace(/？$/,'。')}:p)};
  const stages:string[]=[];
  globalThis.fetch=async(_url,init)=>{
    calls++;const input=JSON.parse(String(init?.body)).input;
    assert.ok(input.startsWith('你是中文社交媒体作者'));
    return Response.json({status:'completed',output_text:JSON.stringify(candidate),usage:{total_tokens:37}});
  };
  try{const result=await generateSocialContent(report,sources,undefined,async stage=>{stages.push(stage);});assert.equal(result.socialContent.status,'ready');assert.equal(calls,1);assert.equal(result.modelCalls,1);assert.equal(result.totalTokens,37);assert.deepEqual(stages,['social-draft-0']);assert.equal(result.socialContent.text,candidate.paragraphs.map(p=>p.text).join('\n\n'));}finally{globalThis.fetch=original;undo();}
});
test('social draft rejects unsupported numbers, removed claims, markdown and fewer actual sources',()=>{
  assert.ok(validateSocialDraft({...socialRaw,paragraphs:[{...socialRaw.paragraphs[0],text:'**编造999**'},...socialRaw.paragraphs.slice(1)]},report,sources).problems.length>=2);
  assert.ok(validateSocialDraft({...socialRaw,paragraphs:socialRaw.paragraphs.map(p=>({...p,claimIds:['removed-claim']}))},report,sources).problems.some(p=>p.includes('不存在')));
  const four={...report,summary:report.summary.map(s=>({...s,references:s.references.filter(r=>r.sourceId!=='S5')}))};
  assert.equal(validateSocialDraft(socialRaw,four,sources).content.coverage.requirementMet,false);
});
test('social copy cannot omit a quantified scope or add a mathematical certainty',()=>{
  const scopedReport={...report,summary:report.summary.map((s,i)=>i===0?{...s,text:'4x4复数矩阵需要48次标量乘法。'}:s)};
  const omitted={paragraphs:[socialRaw.paragraphs[0],{text:'这改写了矩阵运算的定论。',claimIds:['summary-1','summary-2']},socialRaw.paragraphs[2]]};
  assert.ok(validateSocialDraft(omitted,scopedReport,sources).problems.some(p=>p.includes('强断言')));
  const scopedSources=sources.map((s,i)=>i===0?{...s,extractedContent:s.extractedContent+' 48 scalar multiplications.'}:s);
  const withQuotes={...scopedReport,summary:scopedReport.summary.map((s,i)=>i===0?{...s,references:s.references.map(r=>r.sourceId==='S1'?{...r,quote:scopedSources[0].extractedContent}:r)}:s)};
  const numeric={paragraphs:[socialRaw.paragraphs[0],{text:'只需48次标量乘法，矩阵运算就改变了。',claimIds:['summary-1','summary-2']},socialRaw.paragraphs[2]]};
  assert.ok(validateSocialDraft(numeric,withQuotes,scopedSources).problems.some(p=>p.includes('适用范围')));
});
test('an unrelated percentage does not inherit matrix restrictions from a combined summary',()=>{
  const combined={...report,summary:report.summary.map((s,i)=>i===0?{...s,text:'4x4复数矩阵需要48次标量乘法，并持续回收0.7%的计算资源。',references:s.references.map(r=>({...r,quote:r.quote+' 48 scalar multiplications and 0.7% computing resources.'}))}:s)};
  const combinedSources=sources.map(s=>({...s,extractedContent:s.extractedContent+' 48 scalar multiplications and 0.7% computing resources.'}));
  const raw={...socialRaw,paragraphs:socialRaw.paragraphs.map((p,i)=>i===1?{...p,text:'系统持续回收0.7%的计算资源，研究仍需要人的目标与判断。'}:p)};
  assert.deepEqual(validateSocialDraft(raw,combined,combinedSources).problems,[]);
});
test('X limit uses weighted length for Chinese and rejects overlong text without truncation',()=>{
  const checked=validateSocialDraft({...socialRaw,paragraphs:[{text:'中文'.repeat(100),claimIds:[]},...socialRaw.paragraphs.slice(1)]},report,sources);
  assert.ok(checked.problems.some(p=>p.includes('加权长度')));assert.equal(checked.content.text.startsWith('中文'.repeat(100)),true);
});
test('social generation keeps model copy without local content validation or correction',async()=>{
  const undo=restore(['QWEN_API_KEY']);const original=globalThis.fetch;process.env.QWEN_API_KEY='test-only';let calls=0;
  const candidate={...socialRaw,paragraphs:socialRaw.paragraphs.map((p,i)=>i===0?{...p,text:'新增999个未经支持的结果。'}:p)};
  globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.tools,undefined);assert.ok(body.input.startsWith('你是中文社交媒体作者'));if(calls===2)assert.match(body.input,/上次问题：.*未支持的数字/);return Response.json({status:'completed',output_text:JSON.stringify(candidate)});};
  try {const result=await generateSocialContent(report,sources);assert.equal(calls,1);assert.equal(result.modelCalls,1);assert.equal(result.socialContent.status,'ready');assert.equal(result.socialContent.text,candidate.paragraphs.map(p=>p.text).join('\n\n'));assert.equal(result.socialContent.coverage.citedSourceCount,5);}finally{globalThis.fetch=original;undo();}
});
test('unreadable social output fails after one call while retaining known usage',async()=>{
  const undo=restore(['QWEN_API_KEY']);const original=globalThis.fetch;process.env.QWEN_API_KEY='test-only';let calls=0;
  const stages:string[]=[];
  globalThis.fetch=async(_url,init)=>{
    calls++;const input=JSON.parse(String(init?.body)).input;
    assert.ok(input.startsWith('你是中文社交媒体作者'));
    if(calls===2)assert.match(input,/上次问题：JSON格式错误/);
    return Response.json({status:'completed',output_text:calls===1?'invalid JSON':JSON.stringify(socialRaw),usage:{total_tokens:calls*10}});
  };
  try{const result=await generateSocialContent(report,sources,undefined,async stage=>{stages.push(stage);});assert.equal(calls,1);assert.equal(result.modelCalls,1);assert.equal(result.totalTokens,10);assert.deepEqual(stages,['social-draft-0']);assert.equal(result.socialContent.status,'failed');assert.equal(result.socialContent.text,'');assert.match(result.socialContent.warnings[0],/重新生成文案/);}finally{globalThis.fetch=original;undo();}
});
test('signed social retry rejects client changes and a report missing extracted articles',()=>{
  const undo=restore(['QWEN_API_KEY']);process.env.QWEN_API_KEY='test-only';
  try {const token=signSocialSnapshot(report,sources);assert.deepEqual(readSocialSnapshot(token).report,report);assert.throws(()=>readSocialSnapshot(token+'x'));assert.throws(()=>readSocialSnapshot(signSocialSnapshot({...report,summary:[]},sources)));}finally{undo();}
});
test('locally valid report retains all observations and skips model review',async()=>{
  const undo=restore(['QWEN_API_KEY','TAVILY_API_KEY']);const original=globalThis.fetch;process.env.QWEN_API_KEY='test-only';process.env.TAVILY_API_KEY='test-only';let searches=0,reports=0,socialCalls=0;
  const rawReport={title:'test',cards:[],limitations:[],summary:sources.map((s,i)=>({presentation:i===0?'lead':'bullet',...(i?{label:'研究要点'}:{}),text:facts[i],references:[{sourceId:s.id,evidenceId:`${s.id}-E1`}]})).slice(0,3)};
  rawReport.summary.push({presentation:'conclusion',text:'研究结果需要结合适用条件理解。',references:[{sourceId:'S1',evidenceId:'S1-E1'}]});
  // 三条总结覆盖五来源，本地校验通过后直接保留。
  rawReport.summary[0].references.push({sourceId:'S4',evidenceId:'S4-E1'});rawReport.summary[2].references.push({sourceId:'S5',evidenceId:'S5-E1'});
  globalThis.fetch=async(url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(String(url).endsWith('/search')){searches++;return Response.json({results:sources.map(s=>({url:s.url,title:s.title,raw_content:s.extractedContent}))});}
    assert.equal(body.tools,undefined);
    assert.ok(!body.input.startsWith('你是独立'));
    if(body.input.startsWith('你是检索规划'))return Response.json({output_text:JSON.stringify({query:'research question evidence'})});
    if(body.input.startsWith('你是检索评估'))return Response.json({output_text:JSON.stringify({followUpQuery:null})});
    if(body.input.startsWith('你是中文社交媒体作者')){socialCalls++;return Response.json({status:'completed',output_text:JSON.stringify({paragraphs:[{text:'研究中的变化值得关注。',claimIds:[]},{text:'实验评估各有边界。',claimIds:['summary-1']},{text:'这些变化会怎样影响你的工作？',claimIds:[]}]})});}
    reports++;return Response.json({status:'completed',output_text:JSON.stringify(rawReport)});
  };
  try {const r=await analyze('用于测试的研究问题');assert.equal(r.status,'complete');assert.ok(r.report.summary[0].text.includes(facts[2]));assert.equal(r.coverage?.citedSourceCount,5);assert.equal(r.socialContent?.status,'ready');assert.equal(searches,1);assert.equal(reports,1);assert.equal(socialCalls,1);assert.equal(r.diagnostics.modelCalls,4);assert.ok(!r.report.limitations.some(text=>text.includes('模型辅助语义复核')));}finally{globalThis.fetch=original;undo();}
});
test('one structurally invalid metric is dropped without losing valid cited analysis',async()=>{
  const undo=restore(['QWEN_API_KEY']);const original=globalThis.fetch;process.env.QWEN_API_KEY='test-only';
  const refs=[{sourceId:'S1',evidenceId:'S1-E1'}];
  globalThis.fetch=async()=>Response.json({status:'completed',output_text:JSON.stringify({title:'test',summary:[{presentation:'lead',text:'有边界的实验。',references:refs},{presentation:'bullet',label:'适用条件',text:'实验有特定条件。',references:refs},{presentation:'conclusion',text:'应结合条件判断。',references:refs}],cards:[{label:'缺失单位',value:'48',unit:'',references:refs}],limitations:[]})});
  try {const r=await generateReport('研究问题',sources);assert.equal(r.draft.cards.length,0);assert.equal(r.draft.summary.length,3);assert.ok(r.warnings.some(w=>w.includes('已移除')));assert.equal(r.modelCalls,1);}finally{globalThis.fetch=original;undo();}
});
test('evidence budget retains each source and can find relevant evidence beyond the page navigation',()=>{
  const extended=sources.map(s=>({...s,extractedContent:'Navigation sign in subscribe privacy policy '.repeat(350)+'\n\n'+s.extractedContent+' AlphaEvolve evaluation limitations.'}));
  const records=evidenceRegistry(extended,'AlphaEvolve evaluation');
  assert.equal(new Set(records.map(r=>r.sourceId)).size,5);
  assert.ok(records.filter(r=>r.text.includes('AlphaEvolve')).length>=5);
  for(const source of extended)assert.ok(records.filter(r=>r.sourceId===source.id).reduce((sum,r)=>sum+r.text.length,0)<=7000);
});
test('Tavily quota failures and missing configuration produce actionable errors',async()=>{
  const undo=restore(['TAVILY_API_KEY']);const original=globalThis.fetch;
  try {
    delete process.env.TAVILY_API_KEY;await assert.rejects(callTavily('search',{}),(e:unknown)=>e instanceof Error&&e.message.includes('尚未配置'));
    process.env.TAVILY_API_KEY='test-only';
    for(const status of [429,432,433]) {globalThis.fetch=async()=>new Response('private quota payload',{status});await assert.rejects(callTavily('search',{}),(e:unknown)=>e instanceof Error&&e.message.includes('额度')&&!e.message.includes('private'));}
  } finally {globalThis.fetch=original;undo();}
});
test('Tavily timeout is bounded and does not turn a missing body into evidence',async()=>{
  const undo=restore(['TAVILY_API_KEY','TAVILY_TIMEOUT_MS']);const original=globalThis.fetch;process.env.TAVILY_API_KEY='test-only';process.env.TAVILY_TIMEOUT_MS='1000';
  globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>{const keeper=setTimeout(()=>reject(new Error('timer')),2000);init?.signal?.addEventListener('abort',()=>{clearTimeout(keeper);reject(new DOMException('timed out','TimeoutError'));},{once:true});});
  try{await assert.rejects(callTavily('extract',{urls:['https://example.org']}),(e:unknown)=>e instanceof Error&&e.message.includes('超时'));}finally{globalThis.fetch=original;undo();}
});
test('a failed social model call preserves the report and retry snapshot without copying the report',async()=>{
  const undo=restore(['QWEN_API_KEY','TAVILY_API_KEY']);const original=globalThis.fetch;process.env.QWEN_API_KEY='test-only';process.env.TAVILY_API_KEY='test-only';let searches=0;
  const rawReport={title:'test',cards:[],limitations:[],summary:[{presentation:'lead',text:'有边界的实验研究。',references:sources.slice(0,3).map(s=>({sourceId:s.id,evidenceId:`${s.id}-E1`}))},{presentation:'bullet',label:'人的职责',text:'研究仍需要人的目标与判断。',references:sources.slice(3).map(s=>({sourceId:s.id,evidenceId:`${s.id}-E1`}))}]};
  rawReport.summary.push({presentation:'conclusion',text:'理解实验结果仍需要人的判断。',references:[{sourceId:'S1',evidenceId:'S1-E1'}]});
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/search')){searches++;return Response.json({results:sources.map(s=>({url:s.url,title:s.title,raw_content:s.extractedContent}))});}
    const body=JSON.parse(String(init?.body));
    if(body.input.startsWith('你是中文社交媒体作者'))throw new Error('network unavailable');
    if(body.input.startsWith('你是检索规划'))return Response.json({output_text:JSON.stringify({query:'research question evidence'})});
    if(body.input.startsWith('你是检索评估'))return Response.json({output_text:JSON.stringify({followUpQuery:null})});
    return Response.json({status:'completed',output_text:JSON.stringify(rawReport)});
  };
  try {const r=await analyze('用于失败节点测试的问题');assert.equal(r.coverage?.requirementMet,true);assert.equal(r.report.summary.length,1);assert.equal(r.socialContent?.status,'failed');assert.equal(r.socialContent?.text,'');assert.ok(r.socialRetryToken);assert.equal(searches,1);assert.equal(r.diagnostics.modelCalls,4);assert.equal(readSocialSnapshot(r.socialRetryToken!).report.summary.length,1);}finally{globalThis.fetch=original;undo();}
});
test('all twelve extracted articles, including mirrors, survive selection and appear in both outputs',()=>{
  const articles=Array.from({length:12},(_,i)=>({...sources[i%5],id:`S${i+1}`,url:`https://example.org/article-${i}`}));
  assert.equal(eligibleForGeneration({sources:articles,searchCalls:1,extractorCalls:0,credits:0,warnings:[]}).length,12);
  const completed=includeEveryArticle({title:'test',summary:[],cards:[],limitations:[]},articles);
  assert.equal(completed.summary.length,1);
  const social=readSocialForDisplay({ paragraphs: [{ text: "模拟模型改写后的社交文案。" }] }, completed,articles,280);
  assert.equal(social.status,'ready');assert.equal(social.coverage.citedSourceCount,12);
  assert.equal(new Set(social.claimReferences.map(ref=>ref.sourceId)).size,12);
  assert.ok(!social.text.includes('Distinct research source'));
  assert.ok(!social.text.includes('原文线索'));
});
test('an article made of short paragraphs still gets evidence and appears in both outputs',()=>{
  const article={...sources[0],extractedContent:'A short paragraph.\n\n'.repeat(10)};
  const completed=includeEveryArticle({title:'test',summary:[],cards:[],limitations:[]},[article]);
  assert.equal(completed.summary[0].references[0].sourceId,article.id);
  assert.equal(readSocialForDisplay({ paragraphs: [{ text: "模拟模型改写后的社交文案。" }] }, completed,[article],2000).coverage.citedSourceCount,1);
});
test('two articles of one type cannot substitute for a complete answer when Qwen remains unavailable',async()=>{
  const undo=restore(['QWEN_API_KEY','TAVILY_API_KEY']);const original=globalThis.fetch;process.env.QWEN_API_KEY='test-only';process.env.TAVILY_API_KEY='test-only';
  globalThis.fetch=async url=>{if(String(url).endsWith('/search'))return Response.json({results:sources.slice(0,2).map(s=>({url:s.url,title:s.title,raw_content:s.extractedContent}))});throw new Error('network unavailable');};
  try{await assert.rejects(analyze('一类来源的研究观察'),{code:'INVALID_REPORT'});}finally{globalThis.fetch=original;undo();}
});
test('core answer is one paragraph and article titles and extracts stay only in citation metadata',()=>{
  const completed=includeEveryArticle({...report,summary:[...report.summary,{text:'《SECRET SOURCE TITLE》提供的原文线索：“PRIVATE RAW EVIDENCE”。这段材料可与本次问题对照阅读。',references:[{sourceId:'S1',quote:sources[0].extractedContent}]}]},sources);
  assert.equal(completed.summary.length,1);assert.ok(completed.summary[0].text.includes('实验评估各有边界'));
  assert.ok(!completed.summary[0].text.includes('SECRET SOURCE TITLE'));assert.ok(!completed.summary[0].text.includes('PRIVATE RAW EVIDENCE'));
  assert.equal(new Set(completed.summary[0].references.map(ref=>ref.sourceId)).size,5);
});
test('social writing receives only the displayed core observation, excluding cards and source data',async()=>{
  const undo=restore(['QWEN_API_KEY']);const original=globalThis.fetch;process.env.QWEN_API_KEY='test-only';
  const markedSources=sources.map(source=>({...source,title:'SECRET SOURCE TITLE',extractedContent:source.extractedContent+' PRIVATE RAW EVIDENCE'}));
  const markedReport:Draft={...report,summary:report.summary.map((item,index)=>({...item,text:index===0?item.text:'EXCLUDED_SECOND_OBSERVATION',references:item.references.map(ref=>({...ref,quote:ref.quote+' PRIVATE RAW EVIDENCE'}))})),cards:[{claimId:'card-1',label:'EXCLUDED_CARD_TEXT',value:'48',unit:'scalar multiplications',explanation:'EXCLUDED_CARD_EXPLANATION',period:'2024',scope:'test',valueEvidence:'48',unitEvidence:'scalar multiplications',timeEvidence:'2024',references:[]}]};
  globalThis.fetch=async(_url,init)=>{
    const input=JSON.parse(String(init?.body)).input;
    assert.ok(!input.includes('SECRET SOURCE TITLE'));
    assert.ok(!input.includes('PRIVATE RAW EVIDENCE'));
    assert.ok(!input.includes(sources[0].url));
    assert.ok(!input.includes('EXCLUDED_CARD_TEXT'));
    assert.ok(!input.includes('EXCLUDED_CARD_EXPLANATION'));
    assert.ok(!input.includes('EXCLUDED_SECOND_OBSERVATION'));
    assert.ok(!input.includes('研究中的判断与选择'));
    assert.ok(!input.includes('我的想法：'));
    const coreObservation=JSON.parse(input.split('\n核心观察：')[1]);
    assert.equal(coreObservation,markedReport.summary[0].text,'生成必须只接收页面核心观察正文');
    return Response.json({status:'completed',output_text:JSON.stringify(socialRaw)});
  };
  try{const result=await generateSocialContent(markedReport,markedSources);assert.equal(result.socialContent.status,'ready');assert.deepEqual(result.socialContent.warnings,[]);}finally{globalThis.fetch=original;undo();}
});
test('an unsuccessful search reports missing evidence instead of publishing fallback copy',async()=>{
  const undo=restore(['TAVILY_API_KEY']);const original=globalThis.fetch;process.env.TAVILY_API_KEY='test-only';globalThis.fetch=async()=>{throw new Error('network unavailable');};
  try{await assert.rejects(analyze('检索失败时的观察'),{code:'NO_EVIDENCE'});}finally{globalThis.fetch=original;undo();}
});
