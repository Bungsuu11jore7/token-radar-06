// Radar-6 entrypoint: reads the sealed snapshot, fits the comps model at runtime,
// ranks the pre-token board by expected value, writes board.json, data.js and
// dossier.json. Deterministic: no clock, no randomness; two runs are byte-identical.
// Model and verdict rules are unchanged from radar-5 (M1). NEW in v6: each row
// carries a net-of-cost value, a net $/hour and a P25-P75 band; the fit block
// carries the runtime candidate evaluation, range coverage and LOO quantiles;
// the board carries the odds Brier score and the expected/implied totals.
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildDossier } from "./vendor/makefun-board.ts";
import {
  fitComps,
  oddsBuckets,
  oddsFor,
  exclusionReason,
  impliedUsd,
  farmPlan,
  ageDays,
  netEvUsd,
  activeHours,
  netPerHour,
  type Snapshot,
  type SnapshotProtocol,
} from "./lib/model.ts";

function parseInputArg(): string {
  const idx = process.argv.indexOf("--input");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return "/input/snapshot.json";
}

function outputDir(): string {
  const wanted = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  try {
    mkdirSync(wanted, { recursive: true });
    return wanted;
  } catch {
    const fb = join(tmpdir(), "token-radar-06-out");
    mkdirSync(fb, { recursive: true });
    return fb;
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function main(): void {
  const snap = JSON.parse(readFileSync(parseInputArg(), "utf8")) as Snapshot;
  const outDir = outputDir();
  const protocols = snap.protocols;
  const asOf = snap.as_of;

  const traded = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const dropped = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd <= 0).length;
  const fit = fitComps(traded, asOf);
  fit.dropped = dropped;
  // Runtime assert: the fit must reproduce the expected coefficients.
  if (Math.abs(fit.intercept - 3.025) >= 0.01 || Math.abs(fit.slope - 0.522) >= 0.01) {
    throw new Error(`fit drifted: intercept=${fit.intercept} slope=${fit.slope}`);
  }

  const { buckets, overall } = oddsBuckets(protocols, asOf);
  const watchlist = new Set(snap.watchlist);

  // Brier score of the age odds against the base rate, over all 758 protocols.
  let brierModel = 0;
  let brierBase = 0;
  for (const p of protocols) {
    const y = p.mcap_usd !== null ? 1 : 0;
    const pred = oddsFor(ageDays(asOf, p.listed_at), buckets, overall).odds;
    brierModel += (pred - y) ** 2;
    brierBase += (overall - y) ** 2;
  }
  brierModel /= protocols.length;
  brierBase /= protocols.length;

  // Board rows: pre-token protocols that survive the exclusion rules.
  const rows: Record<string, unknown>[] = [];
  const excluded: Record<string, number> = {};
  let excludedCount = 0;
  for (const p of protocols) {
    if (p.mcap_usd !== null) continue; // traded: anchors, not board rows
    const reason = exclusionReason(p);
    if (reason) {
      excluded[reason] = (excluded[reason] ?? 0) + 1;
      excludedCount++;
      continue;
    }
    const age = ageDays(asOf, p.listed_at);
    const o = oddsFor(age, buckets, overall);
    const implied = impliedUsd(p.tvl_usd, fit);
    const expected = Math.max(1, Math.round(implied * o.odds));
    const chain = p.chains && p.chains.length > 0 ? p.chains[0] : "—";
    const plan = farmPlan(p.name, p.category, chain, p.tvl_usd, o.odds, expected);
    const net = netEvUsd(expected, plan);
    const hours = activeHours(plan);
    rows.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: expected,
      farm_steps: plan.steps,
      category: p.category,
      chains: p.chains,
      chain,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: age,
      watchlist: watchlist.has(p.slug),
      implied_usd: implied,
      odds: o.odds,
      odds_bucket: o.bucket,
      odds_n: o.n,
      expected_usd: expected,
      farm_cost_usd: plan.totalCostUsd,
      gas_usd: plan.gasUsd,
      bridge_usd: plan.bridgeUsd,
      capital_usd: plan.capitalUsd,
      weeks: plan.weeks,
      breakeven: plan.breakeven,
      verdict: plan.verdict,
      net_ev_usd: round2(net),
      active_hours: hours,
      net_per_hour_usd: round2(netPerHour(expected, plan)),
      p25_usd: Math.round(implied * 10 ** fit.looQ25),
      p75_usd: Math.round(implied * 10 ** fit.looQ75),
    });
  }
  rows.sort((a, b) => {
    const ea = a.expected_usd as number;
    const eb = b.expected_usd as number;
    if (eb !== ea) return eb - ea;
    const ia = a.implied_usd as number;
    const ib = b.implied_usd as number;
    if (ib !== ia) return ib - ia;
    return (a.slug as string) < (b.slug as string) ? -1 : 1;
  });
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  // Traded anchors: the fit checked against ALL protocols whose token already
  // trades (144, including the 16 with mcap <= 0 that the fit drops).
  const tradedAll = protocols.filter((p) => p.mcap_usd !== null);
  const anchors = tradedAll.map((p: SnapshotProtocol) => {
    const fitted = impliedUsd(p.tvl_usd, fit);
    const actual = p.mcap_usd as number;
    return {
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: actual,
      fitted_usd: fitted,
      ratio: actual / fitted,
      err_dex: actual > 0 ? Math.log10(actual) - Math.log10(fitted) : null,
    };
  });
  anchors.sort((a, b) => b.tvl_usd - a.tvl_usd);

  const totals = {
    expected_usd: rows.reduce((s, r) => s + (r.expected_usd as number), 0),
    implied_usd: rows.reduce((s, r) => s + (r.implied_usd as number), 0),
  };

  const board = {
    generated: asOf,
    fit: {
      n: fit.n,
      dropped: fit.dropped,
      intercept: fit.intercept,
      slope: fit.slope,
      fold_r2: fit.foldR2,
      fold_med: fit.foldMed,
      flat_fold_r2: fit.flatFoldR2,
      flat_fold_med: fit.flatFoldMed,
      walk_r2: fit.walkR2,
      walk_med: fit.walkMed,
      flat_walk_r2: fit.flatWalkR2,
      flat_walk_med: fit.flatWalkMed,
      loo_r2: fit.looR2,
      loo_med: fit.looMed,
      miss_m1: fit.missM1,
      miss_flat: fit.missFlat,
      coverage_50: fit.coverage50,
      coverage_80: fit.coverage80,
      loo_q10: fit.looQ10,
      loo_q25: fit.looQ25,
      loo_q75: fit.looQ75,
      loo_q90: fit.looQ90,
      candidates: fit.candidates,
    },
    odds: buckets.map((b) => ({ label: b.label, n: b.n, with_token: b.withToken, rate: b.rate })),
    odds_overall: overall,
    brier: { model: brierModel, base: brierBase },
    totals,
    coverage: {
      board: rows.length,
      watchlist_total: snap.watchlist.length,
      watchlist_covered: rows.filter((r) => r.watchlist).length,
      traded_anchors: anchors.length,
      excluded: excludedCount,
      excluded_reasons: excluded,
      total: protocols.length,
    },
    rows,
  };
  writeFileSync(join(outDir, "board.json"), JSON.stringify(board, null, 2) + "\n");

  const data = {
    generated: asOf,
    fit: board.fit,
    odds: board.odds,
    odds_overall: overall,
    brier: board.brier,
    totals,
    coverage: board.coverage,
    rows,
    anchors,
  };
  writeFileSync(join(outDir, "data.js"), "window.RADAR = " + JSON.stringify(data) + ";\n");

  // Copy the dashboard and screenshots into /output.
  const here = dirname(new URL(import.meta.url).pathname);
  const dashSrc = join(here, "dashboard");
  const shotSrc = join(here, "screenshots");
  cpSync(dashSrc, join(outDir, "dashboard"), { recursive: true });
  cpSync(shotSrc, join(outDir, "screenshots"), { recursive: true });

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, "dossier.json"), dossier);

  const verdicts = { Farm: 0, Thin: 0, Skip: 0 };
  for (const r of rows) verdicts[r.verdict as keyof typeof verdicts]++;
  console.log(
    `radar-6: board=${rows.length} watchlist=${board.coverage.watchlist_covered}/${snap.watchlist.length} ` +
      `anchors=${anchors.length} fit=${fit.intercept.toFixed(3)}+${fit.slope.toFixed(3)}*logTVL ` +
      `verdicts Farm=${verdicts.Farm} Thin=${verdicts.Thin} Skip=${verdicts.Skip} ` +
      `brier=${brierModel.toFixed(3)}/${brierBase.toFixed(3)} out=${outDir}`,
  );
}

main();
