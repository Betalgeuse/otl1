import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { INTENT_MODEL, intentRequest, readInterpretation } from "../src/intent.ts";

const split = process.argv[2] ?? "development";
if (!["development", "heldout"].includes(split)) throw Error("Use development or heldout");
const config = readFileSync(`${homedir()}/.config/.wrangler/config/default.toml`, "utf8");
const token = config.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!token) throw Error("Run wrangler login first");
const fixtures = JSON.parse(readFileSync(new URL("llm-cases.json", import.meta.url), "utf8"));
const cases = fixtures.filter((item) => item.split === split);
const results = [];
for (let offset = 0; offset < cases.length; offset += 3) {
  await Promise.all(cases.slice(offset, offset + 3).map(async (item) => {
    const start = performance.now();
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/1216831373fd0ae2b3e7c2b6641bee46/ai/run/${INTENT_MODEL}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(intentRequest({ goal: item.goal, text: item.text })),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw Error(`Inference HTTP ${response.status}`);
      const modelActual = readInterpretation(data.result);
      const actual = !item.goal && modelActual.intent === "reflection"
        ? {intent:"unclear",outcome:"unknown"} : modelActual;
      results.push({ id: item.id, expected: { intent: item.intent, outcome: item.outcome }, actual,
        modelActual, pass: actual.intent === item.intent && actual.outcome === item.outcome,
        falseComplete: actual.outcome === "complete" && item.outcome !== "complete",
        ms: Math.round(performance.now() - start), usage: data.result.usage });
    } catch (error) {
      results.push({ id: item.id, pass: false, error: error instanceof Error ? error.message : "Unknown" });
    }
  }));
}
const summary = { model: INTENT_MODEL, split, total: results.length, passed: results.filter(x => x.pass).length,
  falseComplete: results.filter(x => x.falseComplete).length, errors: results.filter(x => x.error).length,
  inputTokens: results.reduce((n,x) => n+(x.usage?.prompt_tokens ?? 0),0),
  outputTokens: results.reduce((n,x) => n+(x.usage?.completion_tokens ?? 0),0),
  neurons: results.reduce((n,x) => n+(x.usage?.neurons ?? 0),0) };
writeFileSync(new URL(`llm-${split}-results.json`, import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), summary, results }, null, 2)+"\n");
console.log(JSON.stringify(summary));
console.log(JSON.stringify(results.filter(x => !x.pass)));
