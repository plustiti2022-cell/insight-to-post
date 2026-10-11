import { test } from "node:test";
import assert from "node:assert/strict";
import { callQwen, outputText } from '../src/server/providers/qwen';
import { AnalysisError } from '../src/server/runtime';
import { generateReport } from '../src/server/services/report';
test("missing key yields actionable configuration error",async()=>{
  const original=process.env.QWEN_API_KEY;delete process.env.QWEN_API_KEY;
  try {await assert.rejects(callQwen("test"),error=>error instanceof AnalysisError&&error.code==="CONFIG_MISSING");}finally{if(original)process.env.QWEN_API_KEY=original;}
});
test("malformed report bounded to one repair",async()=>{
  const fetchOriginal=globalThis.fetch;const key=process.env.QWEN_API_KEY;process.env.QWEN_API_KEY="test-only";let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({status:"completed",output_text:"not JSON"});};
  try{await assert.rejects(generateReport("test",[]),error=>error instanceof AnalysisError&&error.code==="INVALID_REPORT");assert.equal(calls,2);}finally{globalThis.fetch=fetchOriginal;if(key)process.env.QWEN_API_KEY=key;else delete process.env.QWEN_API_KEY;}
});
test("upstream error does not leak credentials or raw body",async()=>{
  const fetchOriginal=globalThis.fetch;const key=process.env.QWEN_API_KEY;process.env.QWEN_API_KEY="test-only";
  globalThis.fetch=async()=>new Response("sensitive upstream body",{status:401});
  try{await assert.rejects(callQwen("test"),error=>error instanceof AnalysisError&&error.code==="AUTH_FAILED"&&!error.message.includes("sensitive"));}finally{globalThis.fetch=fetchOriginal;if(key)process.env.QWEN_API_KEY=key;else delete process.env.QWEN_API_KEY;}
});
test("timeout produces retryable error",async()=>{
  const fetchOriginal=globalThis.fetch;const key=process.env.QWEN_API_KEY;const timeout=process.env.QWEN_TIMEOUT_MS;process.env.QWEN_API_KEY="test-only";process.env.QWEN_TIMEOUT_MS="1000";
  globalThis.fetch=async(_input,init)=>new Promise((_resolve,reject)=>{const keepAlive=setTimeout(()=>reject(new Error("test timeout")),2000);init?.signal?.addEventListener("abort",()=>{clearTimeout(keepAlive);reject(new DOMException("Timeout", "TimeoutError"));},{once:true});});
  try{await assert.rejects(callQwen("test"),error=>error instanceof AnalysisError&&error.code==="TIMEOUT");}finally{globalThis.fetch=fetchOriginal;if(key)process.env.QWEN_API_KEY=key;else delete process.env.QWEN_API_KEY;if(timeout)process.env.QWEN_TIMEOUT_MS=timeout;else delete process.env.QWEN_TIMEOUT_MS;}
});
test('empty convenience output cannot mask a completed message body',()=>{
  assert.equal(outputText({output_text:'',output:[{type:'message',content:[{type:'output_text',text:'{"title":"test","summary":[],"cards":[]}'}]}]}),'{"title":"test","summary":[],"cards":[]}');
});

test('response instructions are sent separately from the unchanged prompt only when provided', async () => {
  const priorFetch = globalThis.fetch, priorKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = 'test-only';
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json({ status: 'completed', output_text: '{}' }); };
  try {
    await callQwen('原提示词', undefined, { instructions: '仅返回 JSON' });
    await callQwen('原提示词');
    assert.equal(requests[0].input, '原提示词');
    assert.equal(requests[0].instructions, '仅返回 JSON');
    assert.equal('instructions' in requests[1], false);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.QWEN_API_KEY; else process.env.QWEN_API_KEY = priorKey;
  }
});
