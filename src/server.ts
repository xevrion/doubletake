import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { check } from "./gateway/pipeline.ts";
import { listProfiles, getProfile } from "./policy/profiles.ts";
import { initAudit, recentAudits, getAudit, recordOverride, purgeExpired, type Override } from "./store/audit.ts";
import { warmNli } from "./detectors/nli.ts";
import { PRICES, routeModel, estimateCost, estimateTokens } from "./detectors/cost.ts";
import { complete, activeProvider, configuredProviders, providers } from "./gateway/upstream.ts";

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true, service: "doubletake" }));

app.get("/api/profiles", (c) => c.json({ profiles: listProfiles() }));

app.get("/api/providers", (c) => c.json({
  active: activeProvider().id,
  configured: configuredProviders().map((p) => ({ id: p.id, label: p.label, model: p.model, note: p.note })),
  all: providers().map((p) => ({ id: p.id, label: p.label, model: p.model, free: p.free, note: p.note, ready: p.id === "mock" || p.id === "ollama" || !!p.apiKey })),
}));

// the end-to-end path: ask a real model, then check what it said before the
// answer is allowed out. this is the whole product in one request.
app.post("/api/ask", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.prompt) return c.json({ error: "field 'prompt' is required" }, 400);

  const sources = Array.isArray(body.sources) ? body.sources : [];
  const profileId = String(body.profileId ?? "support-bot");

  const gen = await complete(String(body.prompt), { sources, system: body.system });

  // cost side: what a frontier model would have cost for the same work.
  const baseline = "claude-class-frontier";
  const baselineCost = estimateCost(baseline, gen.usage.promptTokens, gen.usage.completionTokens);
  const savedUsd = Math.max(0, baselineCost - gen.usage.costUsd);

  const result = await check({
    prompt: String(body.prompt),
    response: gen.text,
    profileId,
    sources,
    history: Array.isArray(body.history) ? body.history : undefined,
    usage: gen.usage,
    savedUsd,
  });

  return c.json({
    ...result,
    generation: {
      provider: gen.provider,
      model: gen.usage.model,
      wallMs: Number(gen.wallMs.toFixed(1)),
      degraded: gen.degraded ?? null,
    },
  });
});

// the main entry point: hand it a prompt + response and it comes back with a
// decision. an enterprise would put this behind its existing llm client, which
// is why the request shape deliberately mirrors what a gateway already has.
app.post("/api/check", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.response || typeof body.response !== "string") {
    return c.json({ error: "field 'response' (string) is required" }, 400);
  }
  const result = await check({
    prompt: String(body.prompt ?? ""),
    response: body.response,
    profileId: String(body.profileId ?? "support-bot"),
    sources: Array.isArray(body.sources) ? body.sources : undefined,
    history: Array.isArray(body.history) ? body.history : undefined,
    usage: body.usage,
    savedUsd: typeof body.savedUsd === "number" ? body.savedUsd : undefined,
  });
  return c.json(result);
});

// the reviewer queue: everything the gateway paused or escalated, newest first.
app.get("/api/queue", (c) => {
  const profileId = c.req.query("profile") ?? undefined;
  const items = recentAudits(200, profileId).filter((r) => r.finalAction === "pause" || r.finalAction === "page");
  return c.json({ items: items.slice(0, 50) });
});

app.get("/api/audit", (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json({ items: recentAudits(Math.min(limit, 200), c.req.query("profile") ?? undefined) });
});

app.get("/api/audit/:id", (c) => {
  const rec = getAudit(c.req.param("id"));
  return rec ? c.json(rec) : c.json({ error: "not found" }, 404);
});

// the feedback loop. a reviewer's verdict is the only real ground truth this
// system ever gets, so it's captured as structured data, not a free-text note.
app.post("/api/audit/:id/override", async (c) => {
  const body = await c.req.json().catch(() => null);
  const rec = getAudit(c.req.param("id"));
  if (!rec) return c.json({ error: "not found" }, 404);
  if (!body?.to || !body?.verdict) return c.json({ error: "fields 'to' and 'verdict' are required" }, 400);

  const o: Override = {
    by: String(body.by ?? "reviewer@demo"),
    at: Date.now(),
    from: rec.finalAction,
    to: body.to,
    reason: String(body.reason ?? ""),
    verdict: body.verdict,
  };
  recordOverride(rec.id, o);
  return c.json({ ok: true, override: o });
});

// what the tuning loop learns from those overrides. we don't silently move
// thresholds -- we show the operator what the data suggests and let them decide.
app.get("/api/tuning", (c) => {
  const all = recentAudits(500);
  const reviewed = all.filter((r) => r.override);
  const byCategory = new Map<string, { fp: number; tp: number; fn: number; scores: number[] }>();

  for (const r of reviewed) {
    const cat = r.topCategory ?? "unknown";
    const e = byCategory.get(cat) ?? { fp: 0, tp: 0, fn: 0, scores: [] };
    const v = r.override!.verdict;
    if (v === "false-positive") { e.fp++; e.scores.push(r.maxScore); }
    else if (v === "true-positive") e.tp++;
    else if (v === "false-negative") e.fn++;
    byCategory.set(cat, e);
  }

  const suggestions = [...byCategory.entries()].map(([category, e]) => {
    const total = e.fp + e.tp;
    const fpRate = total === 0 ? 0 : e.fp / total;
    // if reviewers keep calling our flags wrong, the threshold is too low --
    // and the highest score a reviewer rejected tells us roughly where to move it.
    const worstFp = e.scores.length ? Math.max(...e.scores) : null;
    return {
      category, reviewed: total, falsePositives: e.fp, truePositives: e.tp, falseNegatives: e.fn,
      falsePositiveRate: Number(fpRate.toFixed(3)),
      suggestion: e.fn > 0
        ? `Lower the threshold: ${e.fn} miss(es) reported by reviewers.`
        : fpRate > 0.4 && worstFp !== null
        ? `Raise the patch threshold above ${worstFp.toFixed(2)}: reviewers rejected ${e.fp} of ${total} flags.`
        : total < 5
        ? "Not enough reviewed cases yet to justify a change."
        : "Thresholds look calibrated for this category.",
    };
  });

  return c.json({ reviewedCount: reviewed.length, suggestions });
});

// live economics for the dashboard: what the gateway cost and what routing saved.
app.get("/api/economics", (c) => {
  const all = recentAudits(500);
  const spend = all.reduce((s, r) => s + r.costUsd, 0);
  const saved = all.reduce((s, r) => s + r.savedUsd, 0);
  const byAction = all.reduce<Record<string, number>>((m, r) => {
    m[r.finalAction] = (m[r.finalAction] ?? 0) + 1;
    return m;
  }, {});
  const latencies = all.map((r) => r.latencyMs).sort((a, b) => a - b);
  return c.json({
    interactions: all.length,
    spendUsd: Number(spend.toFixed(4)),
    savedUsd: Number(saved.toFixed(4)),
    netUsd: Number((saved - spend).toFixed(4)),
    byAction,
    latency: {
      p50: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
      p95: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
    },
    prices: PRICES,
  });
});

app.post("/api/route", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const capability = Number(body.capability ?? 0.75);
  const promptTokens = Number(body.promptTokens ?? estimateTokens(String(body.prompt ?? "")));
  const completionTokens = Number(body.completionTokens ?? 400);
  const chosen = routeModel(capability);
  const baseline = "claude-class-frontier";
  return c.json({
    chosen: chosen.model,
    baseline,
    chosenCostUsd: Number(estimateCost(chosen.model, promptTokens, completionTokens).toFixed(6)),
    baselineCostUsd: Number(estimateCost(baseline, promptTokens, completionTokens).toFixed(6)),
    savedUsd: Number((estimateCost(baseline, promptTokens, completionTokens) - estimateCost(chosen.model, promptTokens, completionTokens)).toFixed(6)),
  });
});

app.post("/api/purge", (c) => c.json({ purged: purgeExpired() }));

app.use("/*", serveStatic({ root: "./web" }));

const port = Number(process.env.PORT ?? 3000);

initAudit();
console.log("warming detector models...");
const t0 = performance.now();
await warmNli();
console.log(`models ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log(`DoubleTake listening on http://localhost:${port}`);

export default { port, fetch: app.fetch, idleTimeout: 60 };
