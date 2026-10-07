import { mkdir, writeFile } from "node:fs/promises";
import { analyze } from '../src/server/workflow/run';
const idea = process.argv.slice(2).join(" ") || "AI 如何参与 AI 研发？结合 AlphaEvolve、AI Scientist、自动化机器学习的真实案例说明能力和局限。";
await mkdir(".local", { recursive: true });
const result = await analyze(idea, undefined, async(stage,data)=>{
  await writeFile(`.local/live-${stage}.json`,JSON.stringify(data,null,2));
  console.log(`完成阶段：${stage}`);
}, 2000);
await writeFile(".local/live-report.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, coverage: result.coverage, socialStatus: result.socialContent?.status, socialCoverage: result.socialContent?.coverage, socialWarnings: result.socialContent?.warnings, weightedLength: result.socialContent?.weightedLength, cards: result.report.cards.map(card => ({label:card.label,value:card.value})), warnings: result.warnings, diagnostics: result.diagnostics }, null, 2));
if (!result.coverage?.requirementMet || result.socialContent?.status !== 'ready') process.exitCode = 1;
