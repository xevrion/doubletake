import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { check } from "./gateway/pipeline.ts";
import { listProfiles, getProfile } from "./policy/profiles.ts";
import { initAudit, recentAudits, auditPage, pendingReview, auditStats, getAudit, recordOverride, purgeExpired, type Override } from "./store/audit.ts";
import { warmNli } from "./detectors/nli.ts";
import { warmToxicity } from "./detectors/toxicity-model.ts";
import { initRecall, recentCorrections, verifyLate } from "./gateway/recall.ts";
import { PRICES, routeModel, estimateCost, estimateTokens } from "./detectors/cost.ts";
import { complete, activeProvider, configuredProviders, providers } from "./gateway/upstream.ts";
import { knowledgeBase, allDocuments } from "./store/knowledge.ts";

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true, service: "doubletake" }));

app.get("/api/profiles", (c) => c.json({ profiles: listProfiles() }));

// The demo company's policy documents, so the console can show what answers are
// being checked against. A real deployment supplies these per request instead.
// Example responses the console can load into Live check. Drawn from the same
// corpus the load test uses, so what a person tries by hand and what the
// benchmark measures are the same material.
app.get("/api/samples", async (c) => {
  const corpus = await Bun.file("data/traffic-corpus.json").json() as {
    clean: Record<string, unknown>[];
    hedged: Record<string, unknown>[];
    risky: Record<string, unknown>[];
  };
  const tag = (xs: Record<string, unknown>[], kind: string) => xs.map((x) => ({ ...x, kind }));
  return c.json({
    samples: [
      ...tag(corpus.risky, "risky"),
      ...tag(corpus.clean, "clean"),
      ...tag(corpus.hedged, "hedged"),
    ],
  });
});

app.get("/api/knowledge", (c) => c.json({
  company: knowledgeBase().company,
  documents: allDocuments(),
}));

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
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
  });
  return c.json(result);
});

// the reviewer queue: everything the gateway paused or escalated, newest first.
app.get("/api/queue", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 25), 100);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  return c.json(pendingReview(limit, offset, c.req.query("profile") ?? undefined));
});

app.get("/api/audit", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  return c.json(auditPage(limit, offset, c.req.query("profile") ?? undefined));
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
// one call that populates the whole overview, so the dashboard does not fan
// out into six requests on load.
app.get("/api/overview", (c) => {
  const s = auditStats();
  const e = {
    spendUsd: Number(s.spendUsd.toFixed(5)),
    savedUsd: Number(s.savedUsd.toFixed(5)),
    netUsd: Number((s.savedUsd - s.spendUsd).toFixed(5)),
    perThousandUsd: s.total ? Number(((s.spendUsd / s.total) * 1000).toFixed(3)) : 0,
  };

  return c.json({
    interactions: s.total,
    byAction: s.byAction,
    byProfile: s.byProfile,
    byCategory: s.byCategory,
    uncertain: s.uncertain,
    reviewed: s.reviewed,
    pendingReview: s.pendingReview,
    corrections: recentCorrections(1000).length,
    economics: e,
    latency: {
      p50: Number(s.latency.p50.toFixed(1)),
      p95: Number(s.latency.p95.toFixed(1)),
      p99: Number(s.latency.p99.toFixed(1)),
    },
    recent: recentAudits(12).map((r) => ({
      id: r.id, ts: r.ts, profileId: r.profileId, action: r.finalAction,
      topCategory: r.topCategory, maxScore: r.maxScore, latencyMs: r.latencyMs,
      prompt: r.promptPreview.slice(0, 70), reviewed: !!r.override,
    })),
  });
});

// Served from the API rather than as a static file, because the console build
// owns web/ and would wipe it. Lost once already to a careless edit, which the
// self check now guards against.
app.get("/eval-results.json", async (c) => {
  const f = Bun.file("data/eval-results.json");
  if (!(await f.exists())) return c.json({ error: "run `bun run eval` first" }, 404);
  return c.json(await f.json());
});

app.get("/api/economics", (c) => {
  const s = auditStats();
  return c.json({
    interactions: s.total,
    spendUsd: Number(s.spendUsd.toFixed(4)),
    savedUsd: Number(s.savedUsd.toFixed(4)),
    netUsd: Number((s.savedUsd - s.spendUsd).toFixed(4)),
    byAction: s.byAction,
    latency: { p50: s.latency.p50, p95: s.latency.p95 },
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

app.get("/api/corrections", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 25), 100);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const all = recentCorrections(1000);
  return c.json({ items: all.slice(offset, offset + limit), total: all.length, offset, limit });
});

// force a late check on demand, so the demo can show recall-and-correct without
// waiting for the sampler to pick a request.
app.post("/api/recall/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const correction = await verifyLate(c.req.param("id"), {
    prompt: String(body.prompt ?? ""), response: String(body.response ?? ""),
    profileId: String(body.profileId ?? "support-bot"),
    sources: Array.isArray(body.sources) ? body.sources : undefined,
  });
  return c.json({ corrected: !!correction, correction });
});

app.post("/api/purge", (c) => c.json({ purged: purgeExpired() }));

app.use("/*", serveStatic({ root: "./web" }));

const port = Number(process.env.PORT ?? 3000);

initAudit();
initRecall();
console.log("warming detector models...");
const t0 = performance.now();
// both are loaded before the first request; a 7-second cold start belongs at
// boot, never in a user's request path.
await Promise.all([warmNli(), warmToxicity()]);
console.log(`models ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log(`DoubleTake listening on http://localhost:${port}`);

export default { port, fetch: app.fetch, idleTimeout: 60 };
