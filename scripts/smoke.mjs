/**
 * Post-deploy smoke test. Verifies the bridge is up and translating correctly
 * without spending any Sarvam credit.
 *
 *   node scripts/smoke.mjs [baseUrl]
 */
const base = process.argv[2] ?? process.env.BRIDGE_URL ?? "http://localhost:8080";

const checks = [
  ["liveness", async () => {
    const r = await fetch(`${base}/healthz`);
    if (!r.ok) throw new Error(`healthz returned ${r.status}`);
    return (await r.json()).status;
  }],
  ["readiness", async () => {
    const r = await fetch(`${base}/readyz`);
    if (!r.ok) throw new Error(`readyz returned ${r.status}`);
    return (await r.json()).status;
  }],
  ["script detection", async () => {
    const r = await fetch(`${base}/v1/bridge/explain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "নমস্কার, কেমন আছেন?" }),
    });
    const d = await r.json();
    if (d.language.resolved !== "bn-IN") {
      throw new Error(`expected bn-IN, got ${d.language.resolved}`);
    }
    return `${d.language.resolved} via ${d.language.source}`;
  }],
  ["voice catalogue", async () => {
    const r = await fetch(`${base}/v1/voices`);
    const d = await r.json();
    if (!Array.isArray(d.voices) || d.voices.length === 0) {
      throw new Error("empty voice catalogue");
    }
    return `${d.voices.length} voices`;
  }],
];

let failed = 0;
for (const [name, run] of checks) {
  try {
    console.log(`  PASS  ${name.padEnd(18)} ${await run()}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name.padEnd(18)} ${err.message}`);
  }
}

console.log(failed === 0 ? "\nAll smoke checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
