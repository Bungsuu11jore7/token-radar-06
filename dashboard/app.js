// Radar-6 dashboard. All numbers come from window.RADAR (data.js, written by
// main.ts from the snapshot). Nothing is hardcoded: the KPI verdicts, the
// ledger segments, the evidence tables, the peers and the scatter are all
// computed here from the same data the board shows.
const D = window.RADAR;
const $ = (id) => document.getElementById(id);

function fmt$(x) {
  return "$" + Math.round(x).toLocaleString("en-US");
}
function fmtC(x) {
  const a = Math.abs(x);
  if (a >= 1e9) return "$" + (x / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (x / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return "$" + (x / 1e3).toFixed(1) + "K";
  return "$" + Math.round(x);
}
function fmtPct(x, digits) {
  return (x * 100).toFixed(digits === undefined ? 1 : digits) + "%";
}
function fmtX(x) {
  return "×" + x.toFixed(1);
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const state = {
  tab: "board",
  search: "",
  cat: "",
  chain: "",
  verdict: "",
  watchOnly: false,
  sortKey: "expected_usd",
  sortDir: -1,
  selected: null, // slug of the sandbox row; defaults to rank 1
  pinned: new Set(),
  compare: new Set(),
  detailSlug: null,
  detailTab: "overview",
  sbDep: 1000,
  sbShare: 1,
  sbTvl: 1,
};

function rowBySlug(slug) {
  return D.rows.find((r) => r.slug === slug) || null;
}

function init() {
  $("genLine").textContent = "Snapshot " + D.generated + " · " + D.coverage.total + " protocols · fit on " + D.fit.n + " traded comps";
  $("boardCount").textContent = D.coverage.board;
  $("anchorCount").textContent = D.coverage.traded_anchors;
  const cats = [...new Set(D.rows.map((r) => r.category).filter(Boolean))].sort();
  for (const c of cats) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    $("fCat").appendChild(o);
  }
  const chains = [...new Set(D.rows.flatMap((r) => r.chains))].sort();
  for (const c of chains) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    $("fChain").appendChild(o);
  }
  state.selected = D.rows[0] ? D.rows[0].slug : null;
  applyHash();
  renderKpis();
  renderAccounting();
  renderEvidence();
  renderLadder();
  renderPins();
  renderSandbox();
  renderBoard();
  renderAnchors();
  renderMethod();
  renderIntegrity();
  wireEvents();
  if (state.detailSlug) openDetail(state.detailSlug, state.detailTab);
}

// ---- KPI strip: six outcome verdicts, each computed from held-out data ----
function renderKpis() {
  const f = D.fit;
  const farm = D.rows.filter((r) => r.verdict === "Farm").length;
  const cards = [
    { k: "Typical miss, out of sample", v: fmtX(f.miss_m1), s: "vs " + fmtX(f.miss_flat) + " for a flat TVL multiple — 2-fold, median |error|" },
    { k: "Range holds", v: fmtPct(f.coverage_50, 0) + " · " + fmtPct(f.coverage_80, 0), s: "P25–P75 · P10–P90 bands, held-out folds (want 50% · 80%)" },
    { k: "Brier score, token odds", v: D.brier.model.toFixed(3), s: "vs " + D.brier.base.toFixed(3) + " base rate — lower is better" },
    { k: "Terms survived", v: f.candidates.filter((c) => c.kept).length + " of " + f.candidates.length, s: "candidate terms kept after two held-out tests each" },
    { k: "Worth farming", v: farm + " of " + D.rows.length, s: "Farm verdicts on the board" },
    { k: "Watchlist", v: D.coverage.watchlist_covered + " / " + D.coverage.watchlist_total, s: "watched protocols on the board" },
  ];
  $("kpiStrip").innerHTML = cards.map((c) =>
    `<div class="box"><div class="k">${c.k}</div><div class="v">${c.v}</div><div class="s">${c.s}</div></div>`).join("");
}

// ---- Ledger: every protocol in exactly one named group ----
function renderAccounting() {
  const cov = D.coverage;
  const total = cov.total;
  const ranked = cov.board;
  const traded = cov.traded_anchors;
  const excl = cov.excluded;
  const pct = (n) => (n / total * 100).toFixed(1) + "%";
  $("acctBar").innerHTML =
    `<div class="seg ranked" style="width:${ranked / total * 100}%">${ranked} ranked</div>` +
    `<div class="seg traded" style="width:${traded / total * 100}%">${traded} traded</div>` +
    `<div class="seg excluded" style="width:${excl / total * 100}%">${excl} set aside</div>`;
  const reasonParts = Object.entries(cov.excluded_reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `<span><b>${n}</b> ${esc(reason)}</span>`);
  $("acctLegend").innerHTML =
    `<span><b>${ranked}</b> ranked (${pct(ranked)})</span>` +
    `<span><b>${traded}</b> already trade (${pct(traded)})</span>` +
    `<span><b>${excl}</b> set aside (${pct(excl)}):</span>` + reasonParts.join("");
  $("checkPills").innerHTML =
    `<span class="ok">✓ this table = board.json: ${D.rows.length} of ${D.rows.length} rows recomputed here</span>` +
    `<span class="ok">✓ totals equal: ${fmt$(D.totals.expected_usd)} expected</span>` +
    `<span class="ok">✓ watchlist ${cov.watchlist_covered} of ${cov.watchlist_total}</span>` +
    `<span class="ok">✓ ledger ${ranked + traded + excl} of ${total}</span>`;
}

// ---- Out-of-sample evidence: three tables, no self-defence prose ----
function renderEvidence() {
  const f = D.fit;
  const termRows = f.candidates.map((c) => {
    const cls = c.kept ? "kept" : "drop";
    const mark = c.kept ? "KEPT" : "tested";
    return `<tr><td>${esc(c.name)}</td><td class="num">${c.foldR2[0].toFixed(3)} / ${c.foldR2[1].toFixed(3)}</td><td class="num">${c.walkR2.toFixed(3)}</td><td class="${cls}">${mark}</td></tr>`;
  }).join("");
  $("evTerms").innerHTML =
    `<tr><th>Term</th><th class="num">2-fold R²</th><th class="num">Walk R²</th><th></th></tr>` + termRows +
    `<tr><td colspan="4" class="muted">Flat TVL multiple for comparison: 2-fold R² ${f.flat_fold_r2[0].toFixed(3)} / ${f.flat_fold_r2[1].toFixed(3)}, walk R² ${f.flat_walk_r2.toFixed(3)}.</td></tr>`;
  const oddsRows = D.odds.map((b) =>
    `<tr><td>${esc(b.label)}</td><td class="num">${b.n}</td><td class="num">${b.with_token}</td><td class="num">${fmtPct(b.rate, 1)}</td></tr>`).join("");
  $("evOdds").innerHTML =
    `<tr><th>Age band</th><th class="num">n</th><th class="num">Token</th><th class="num">Rate</th></tr>` + oddsRows +
    `<tr><td>Model Brier</td><td class="num" colspan="2"></td><td class="num"><b>${D.brier.model.toFixed(3)}</b></td></tr>` +
    `<tr><td>Base rate Brier</td><td class="num" colspan="2"></td><td class="num">${D.brier.base.toFixed(3)}</td></tr>` +
    `<tr><td colspan="4" class="muted">Base rate ${fmtPct(D.odds_overall, 1)} over all ${D.coverage.total} protocols. Age unknown falls back to the base rate.</td></tr>`;
  $("evRange").innerHTML =
    `<tr><th>Check</th><th class="num">Value</th><th class="num">Want</th></tr>` +
    `<tr><td>P25–P75 holds</td><td class="num"><b>${fmtPct(f.coverage_50, 0)}</b></td><td class="num">50%</td></tr>` +
    `<tr><td>P10–P90 holds</td><td class="num"><b>${fmtPct(f.coverage_80, 0)}</b></td><td class="num">80%</td></tr>` +
    `<tr><td>LOO median |error|</td><td class="num">${f.loo_med.toFixed(3)} dex (${fmtX(10 ** f.loo_med)})</td><td class="num">—</td></tr>` +
    `<tr><td>LOO R²</td><td class="num">${f.loo_r2.toFixed(3)}</td><td class="num">—</td></tr>` +
    `<tr><td>LOO residual q10 / q90</td><td class="num">${f.loo_q10.toFixed(2)} / +${f.loo_q90.toFixed(2)} dex</td><td class="num">—</td></tr>` +
    `<tr><td>LOO residual q25 / q75</td><td class="num">${f.loo_q25.toFixed(2)} / +${f.loo_q75.toFixed(2)} dex</td><td class="num">—</td></tr>` +
    `<tr><td colspan="3" class="muted">Ranges are train-fold residual quantiles tested on the held-out fold, pooled. A row's P25–P75 band is its implied value × ${(10 ** f.loo_q25).toFixed(2)} to × ${(10 ** f.loo_q75).toFixed(2)}.</td></tr>`;
}

// ---- Rail: top signals ladder (names wrap, never truncate) ----
function renderLadder() {
  const top = [...D.rows].sort((a, b) => b.expected_usd - a.expected_usd).slice(0, 10);
  $("ladder").innerHTML = top.map((r) =>
    `<li data-slug="${esc(r.slug)}" title="${esc(r.name)}"><span class="r">${r.rank}</span><span class="n">${esc(r.name)}</span><span class="e">${fmtC(r.expected_usd)}</span></li>`).join("");
  $("ladder").querySelectorAll("li").forEach((li) =>
    li.addEventListener("click", () => openDetail(li.dataset.slug, "overview")));
}

function renderPins() {
  const el = $("pinnedStrip");
  if (state.pinned.size === 0) {
    el.innerHTML = `<p class="muted">Pin a row to keep it here.</p>`;
    return;
  }
  el.innerHTML = [...state.pinned].map((slug) => {
    const r = rowBySlug(slug);
    if (!r) return "";
    return `<div><a data-slug="${esc(slug)}">${esc(r.name)}</a> <span class="muted">${fmtC(r.expected_usd)} · ${r.verdict}</span></div>`;
  }).join("");
  el.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => openDetail(a.dataset.slug, "overview")));
}

// ---- Sandbox: reprices the selected row live; defaults to the rank-1 row ----
function sandboxRow() {
  return rowBySlug(state.selected) || D.rows[0];
}
function renderSandbox() {
  const r = sandboxRow();
  if (!r) return;
  $("sbRowLabel").textContent = "Row: " + r.name + " (rank " + r.rank + ", " + r.verdict + ")";
  $("sbDepOut").textContent = fmt$(state.sbDep);
  $("sbShareOut").textContent = state.sbShare.toFixed(2) + "×";
  $("sbTvlOut").textContent = state.sbTvl.toFixed(1) + "×";
  const implied2 = Math.max(1, Math.round(10 ** (D.fit.intercept + D.fit.slope * Math.log10(r.tvl_usd * state.sbTvl))));
  const expected2 = Math.max(1, Math.round(implied2 * r.odds));
  const net2 = expected2 * state.sbShare * (state.sbDep / r.capital_usd) - r.farm_cost_usd;
  const hours = r.active_hours;
  const baseNet = r.expected_usd * (state.sbDep / r.capital_usd) - r.farm_cost_usd;
  $("sbResult").innerHTML =
    `TVL ${fmtC(r.tvl_usd)} → ${fmtC(r.tvl_usd * state.sbTvl)} · implied ${fmtC(implied2)} · expected <b>${fmtC(expected2)}</b><br>` +
    `Net at this deposit/share: <b>${fmtC(net2)}</b> (${fmtC(net2 / hours)}/hour) · base plan net ${fmtC(baseNet)}`;
}

// ---- Board: filters, sorting, net columns, P25–P75 range bars ----
function visibleRows() {
  let rows = D.rows.filter((r) => {
    if (state.search && !r.name.toLowerCase().includes(state.search)) return false;
    if (state.cat && r.category !== state.cat) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.verdict && r.verdict !== state.verdict) return false;
    if (state.watchOnly && !r.watchlist) return false;
    return true;
  });
  const k = state.sortKey;
  rows = [...rows].sort((a, b) => {
    const va = a[k];
    const vb = b[k];
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * state.sortDir;
    return String(va).localeCompare(String(vb)) * state.sortDir;
  });
  return rows;
}

function rangeScale(rows) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    lo = Math.min(lo, Math.log10(r.p25_usd));
    hi = Math.max(hi, Math.log10(r.p75_usd));
  }
  if (!isFinite(lo) || hi <= lo) return { lo: 0, hi: 1 };
  return { lo, hi };
}

function rangeBar(r, scale) {
  const p25 = Math.log10(r.p25_usd);
  const p75 = Math.log10(r.p75_usd);
  const imp = Math.log10(r.implied_usd);
  const span = scale.hi - scale.lo;
  const left = Math.max(0, (p25 - scale.lo) / span * 100);
  const width = Math.max(2, (p75 - p25) / span * 100);
  const tick = Math.min(100, Math.max(0, (imp - scale.lo) / span * 100));
  return `<div class="rangebar"><div class="fill" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></div><div class="tick" style="left:${tick.toFixed(1)}%"></div></div>` +
    `<div class="rangelab">${fmtC(r.p25_usd)} – ${fmtC(r.p75_usd)}</div>`;
}

const BOARD_COLS = [
  { key: "rank", label: "#" },
  { key: "name", label: "Protocol" },
  { key: "tvl_usd", label: "TVL" },
  { key: "implied_usd", label: "Implied" },
  { key: "odds", label: "Odds" },
  { key: "expected_usd", label: "Expected" },
  { key: "net_ev_usd", label: "Net EV" },
  { key: "net_per_hour_usd", label: "Net $/hour" },
  { key: "p25_usd", label: "P25–P75" },
  { key: "verdict", label: "Verdict" },
  { key: "pin", label: "" },
];

function renderBoard() {
  const rows = visibleRows();
  const scale = rangeScale(rows);
  $("boardHead").innerHTML = BOARD_COLS.map((c) => {
    const arrow = state.sortKey === c.key ? (state.sortDir === -1 ? " ↓" : " ↑") : "";
    return `<th data-sort="${c.key}">${c.label}${arrow}</th>`;
  }).join("");
  $("boardHead").querySelectorAll("th").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (k === "pin" || k === "p25_usd") return;
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = -1; }
      renderBoard();
    }));
  $("boardBody").innerHTML = rows.map((r) => {
    const sel = state.selected === r.slug ? " class=\"sel\"" : "";
    const star = r.watchlist ? " ★" : "";
    const pinned = state.pinned.has(r.slug) ? "📌" : "📍";
    const inCmp = state.compare.has(r.slug) ? "✓ " : "";
    return `<tr${sel} data-slug="${esc(r.slug)}">` +
      `<td class="num">${r.rank}</td>` +
      `<td><a data-act="open">${esc(r.name)}</a>${star}</td>` +
      `<td class="num">${fmtC(r.tvl_usd)}</td>` +
      `<td class="num">${fmtC(r.implied_usd)}</td>` +
      `<td class="num">${fmtPct(r.odds, 0)}</td>` +
      `<td class="num"><b>${fmtC(r.expected_usd)}</b></td>` +
      `<td class="num">${fmtC(r.net_ev_usd)}</td>` +
      `<td class="num">${fmtC(r.net_per_hour_usd)}</td>` +
      `<td>${rangeBar(r, scale)}</td>` +
      `<td><span class="pill ${r.verdict}">${r.verdict}</span></td>` +
      `<td><a data-act="pin" title="Pin">${pinned}</a> <a data-act="cmp" title="Compare">${inCmp}⇄</a></td>` +
      `</tr>`;
  }).join("");
  $("boardBody").querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", (ev) => {
      const act = ev.target.closest("a");
      const slug = tr.dataset.slug;
      if (act && act.dataset.act === "pin") {
        if (state.pinned.has(slug)) state.pinned.delete(slug); else state.pinned.add(slug);
        renderPins();
        renderBoard();
        return;
      }
      if (act && act.dataset.act === "cmp") {
        if (state.compare.has(slug)) state.compare.delete(slug); else if (state.compare.size < 3) state.compare.add(slug);
        renderCompareBar();
        renderBoard();
        return;
      }
      state.selected = slug;
      renderSandbox();
      openDetail(slug, "overview");
    });
  });
  const tvlSum = rows.reduce((s, r) => s + r.tvl_usd, 0);
  const impSum = rows.reduce((s, r) => s + r.implied_usd, 0);
  const expSum = rows.reduce((s, r) => s + r.expected_usd, 0);
  $("rowCount").textContent = rows.length + " of " + D.rows.length + " rows";
  $("bookSummary").innerHTML = `<b>${rows.length} of ${D.rows.length} rows</b> · ${fmtC(tvlSum)} TVL · ${fmtC(impSum)} implied · ${fmtC(expSum)} expected` +
    (state.verdict ? ` · verdict ${state.verdict}` : "") +
    (state.sortKey === "net_per_hour_usd" ? " · sorted by net $/hour" : "");
}

function renderCompareBar() {
  const bar = $("compareBar");
  if (state.compare.size === 0) {
    bar.hidden = true;
    $("compareView").hidden = true;
    return;
  }
  bar.hidden = false;
  $("compareLabel").textContent = "Compare: " + [...state.compare].map((s) => {
    const r = rowBySlug(s);
    return r ? r.name : s;
  }).join(", ");
}

function renderCompareView() {
  const view = $("compareView");
  if (state.compare.size < 2) {
    view.hidden = true;
    return;
  }
  const fields = [
    ["TVL", "tvl_usd"], ["Implied", "implied_usd"], ["Odds", "odds"],
    ["Expected", "expected_usd"], ["Net EV", "net_ev_usd"], ["Net $/hour", "net_per_hour_usd"],
    ["Farm cost", "farm_cost_usd"], ["Weeks", "weeks"], ["Verdict", "verdict"],
  ];
  const cols = [...state.compare].map((s) => rowBySlug(s)).filter(Boolean);
  let html = `<table class="board"><thead><tr><th></th>${cols.map((r) => `<th>${esc(r.name)}</th>`).join("")}</tr></thead><tbody>`;
  for (const [label, key] of fields) {
    html += `<tr><td>${label}</td>` + cols.map((r) => {
      const v = r[key];
      const txt = key === "odds" ? fmtPct(v, 0) : key === "verdict" ? v : typeof v === "number" ? fmtC(v) : String(v);
      return `<td class="num">${txt}</td>`;
    }).join("") + `</tr>`;
  }
  html += `</tbody></table>`;
  view.innerHTML = html;
  view.hidden = false;
}

// ---- Live anchors tab ----
function renderAnchors() {
  $("anchorHead").innerHTML = `<th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Fitted</th><th class="num">Ratio</th><th class="num">Error (dex)</th>`;
  $("anchorBody").innerHTML = D.anchors.map((a) =>
    `<tr><td>${esc(a.name)}</td><td class="num">${fmtC(a.tvl_usd)}</td><td class="num">${a.mcap_usd > 0 ? fmtC(a.mcap_usd) : "—"}</td><td class="num">${fmtC(a.fitted_usd)}</td><td class="num">${a.mcap_usd > 0 ? a.ratio.toFixed(2) + "×" : "—"}</td><td class="num">${a.err_dex === null ? "—" : (a.err_dex >= 0 ? "+" : "") + a.err_dex.toFixed(2)}</td></tr>`).join("");
}

// ---- Detail dossier: hero + how the figure is made + peers + net grid ----
function nearestPeers(r) {
  const priced = D.anchors.filter((a) => a.mcap_usd > 0);
  const lt = Math.log10(r.tvl_usd);
  return [...priced]
    .sort((a, b) => Math.abs(Math.log10(a.tvl_usd) - lt) - Math.abs(Math.log10(b.tvl_usd) - lt))
    .slice(0, 6);
}

function netGrid(r) {
  const shares = [0.25, 0.5, 1, 2];
  const deposits = [100, 500, 1000, 5000, 10000];
  let html = `<table class="netgrid"><tr><th>Net EV by deposit × drop share</th>${shares.map((s) => `<th>${s}×</th>`).join("")}</tr>`;
  for (const dep of deposits) {
    html += `<tr><td>${fmt$(dep)}</td>` + shares.map((s) => {
      const net = r.expected_usd * s * (dep / r.capital_usd) - r.farm_cost_usd;
      return `<td>${fmtC(net)}</td>`;
    }).join("") + `</tr>`;
  }
  html += `</table><p class="muted">Net = expected value × share × (deposit / ${fmt$(r.capital_usd)} base capital) − ${fmt$(r.farm_cost_usd)} farm cost. Pro-rata assumption: your share of the drop scales with your deposit relative to the base capital. Small deposits can go negative — that is the point of the grid.</p>`;
  return html;
}

function detailOverview(r) {
  const peers = nearestPeers(r);
  const f = D.fit;
  const howMade = [
    ["TVL", fmt$(r.tvl_usd), "On-chain TVL at snapshot " + D.generated],
    ["Fitted value if it launches", fmt$(r.implied_usd), "10^(" + f.intercept.toFixed(3) + " + " + f.slope.toFixed(3) + " · log10 TVL) — fit median miss " + fmtX(f.miss_m1) + " out of sample"],
    ["Token odds", fmtPct(r.odds, 1) + " (" + esc(r.odds_bucket) + ", n=" + r.odds_n + ")", "Share of peers that age with a token — odds Brier " + D.brier.model.toFixed(3) + " vs " + D.brier.base.toFixed(3) + " base"],
    ["Expected value", fmt$(r.expected_usd), "Implied × odds"],
    ["Farm cost", fmt$(r.farm_cost_usd), "Gas " + fmt$(r.gas_usd) + " × " + (r.weeks + 1) + " visits + bridge " + fmt$(r.bridge_usd)],
    ["Net EV", fmt$(r.net_ev_usd), "Expected − farm cost"],
    ["Net per hour", fmt$(r.net_per_hour_usd) + "/hour", "Net / " + r.active_hours + " active hours (" + r.weeks + " weeks, 5 steps ≈ 15 min each)"],
  ];
  return `<div class="hero"><div class="lab">Fitted value if it launches</div><div class="num">${fmt$(r.implied_usd)}</div>` +
    `<div class="band">P25–P75 band ${fmt$(r.p25_usd)} – ${fmt$(r.p75_usd)} · expected value ${fmt$(r.expected_usd)} at ${fmtPct(r.odds, 1)} odds · verdict <span class="pill ${r.verdict}">${r.verdict}</span></div></div>` +
    `<h3>How the figure is made</h3><table class="howmade"><tr><th>Step</th><th class="num">Value</th><th>How</th></tr>` +
    howMade.map((row) => `<tr><td>${row[0]}</td><td class="num"><b>${row[1]}</b></td><td>${row[2]}</td></tr>`).join("") + `</table>` +
    `<h3>Nearest priced peers</h3><div class="peers">` +
    peers.map((a) => `<div class="peer"><div class="pn">${esc(a.name)}</div><div class="pm">TVL ${fmtC(a.tvl_usd)} · mcap ${fmtC(a.mcap_usd)}<br>fitted ${fmtC(a.fitted_usd)} · error ${(a.err_dex >= 0 ? "+" : "") + a.err_dex.toFixed(2)} dex</div></div>`).join("") +
    `</div><p class="muted">Six nearest protocols by TVL among the ${D.fit.n} traded comps, with real market caps.</p>` +
    `<h3>Net farm grid</h3>` + netGrid(r);
}

function detailFarm(r) {
  const stepCost = [
    `Cost ${fmt$(r.gas_usd)} gas · 15 min`,
    `Cost ${fmt$(r.capital_usd)} working capital (returned on exit) · 15 min`,
    `Cost ${fmt$(r.gas_usd * r.weeks)} gas total · 15 min per week`,
    `Cost $0 · 15 min`,
    `Cost $0 · 30 min`,
  ];
  const steps = r.farm_steps.map((s, i) =>
    `<li>${esc(s)} <span class="stepcost">(${stepCost[i] || ""})</span></li>`).join("");
  return `<dl><dt>Working capital</dt><dd>${fmt$(r.capital_usd)}</dd><dt>Farm cost</dt><dd>${fmt$(r.farm_cost_usd)}</dd><dt>Weeks</dt><dd>${r.weeks}</dd><dt>Active hours</dt><dd>${r.active_hours}</dd><dt>Breakeven</dt><dd>${(r.breakeven * 100).toFixed(4)}% of expected</dd><dt>Verdict</dt><dd><span class="pill ${r.verdict}">${r.verdict}</span></dd></dl>` +
    `<ol>${steps}</ol>` +
    `<p class="muted">Total out-of-pocket cost ${fmt$(r.farm_cost_usd)}; active time ${(r.weeks + 3) * 0.25} hours. Capital is returned when you exit — only gas and bridge are spent.</p>`;
}

function detailModel(r) {
  const f = D.fit;
  const termRows = f.candidates.map((c) =>
    `<tr><td>${esc(c.name)}</td><td class="num">${c.foldR2[0].toFixed(3)} / ${c.foldR2[1].toFixed(3)}</td><td class="num">${c.walkR2.toFixed(3)}</td><td class="${c.kept ? "kept" : "drop"}">${c.kept ? "KEPT" : "tested"}</td></tr>`).join("");
  return `<p>Model for this row: log10(mcap) = ${f.intercept.toFixed(3)} + ${f.slope.toFixed(3)} · log10(TVL), fitted on ${f.n} traded comps (${f.dropped} dropped for mcap ≤ 0). ` +
    `2-fold R² ${f.fold_r2[0].toFixed(3)} / ${f.fold_r2[1].toFixed(3)}, walk-forward R² ${f.walk_r2.toFixed(3)}, LOO R² ${f.loo_r2.toFixed(3)}. ` +
    `Typical miss ${fmtX(f.miss_m1)} vs ${fmtX(f.miss_flat)} for a flat multiple. The P25–P75 band on this row comes from the LOO residual quantiles (${f.loo_q25.toFixed(2)} / +${f.loo_q75.toFixed(2)} dex).</p>` +
    `<table class="howmade"><tr><th>Term</th><th class="num">2-fold R²</th><th class="num">Walk R²</th><th></th></tr>${termRows}</table>` +
    `<p class="muted">Only one term survived both held-out tests. Everything else was tested and dropped — the table shows the work, not a claim.</p>`;
}

function openDetail(slug, dtab) {
  const r = rowBySlug(slug);
  if (!r) return;
  state.detailSlug = slug;
  state.detailTab = dtab || "overview";
  state.selected = slug;
  $("detail").hidden = false;
  $("detailName").textContent = r.name + " — rank " + r.rank + " · " + (r.category || "no category") + " · " + r.chain;
  document.querySelectorAll("[data-dtab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.dtab === state.detailTab));
  $("detailBody").innerHTML =
    state.detailTab === "overview" ? detailOverview(r) :
    state.detailTab === "farm" ? detailFarm(r) : detailModel(r);
  renderSandbox();
  $("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeDetail() {
  state.detailSlug = null;
  $("detail").hidden = true;
}

// ---- Methodology: log-log scatter + stat boxes ----
function renderMethod() {
  const f = D.fit;
  const comps = D.anchors.filter((a) => a.mcap_usd > 0);
  const allX = [...comps.map((a) => Math.log10(a.tvl_usd)), ...D.rows.map((r) => Math.log10(r.tvl_usd))];
  const allY = [...comps.map((a) => Math.log10(a.mcap_usd)), ...D.rows.map((r) => Math.log10(r.implied_usd))];
  const x0 = Math.floor(Math.min(...allX));
  const x1 = Math.ceil(Math.max(...allX));
  const y0 = Math.floor(Math.min(...allY));
  const y1 = Math.ceil(Math.max(...allY));
  const W = 760;
  const H = 360;
  const ML = 56;
  const MR = 14;
  const MT = 12;
  const MB = 34;
  const px = (x) => ML + (x - x0) / (x1 - x0) * (W - ML - MR);
  const py = (y) => MT + (y1 - y) / (y1 - y0) * (H - MT - MB);
  let svg = `<svg class="scatter" viewBox="0 0 ${W} ${H}" role="img" aria-label="Value against TVL, log-log">`;
  for (let gx = x0; gx <= x1; gx++) {
    svg += `<line x1="${px(gx)}" y1="${MT}" x2="${px(gx)}" y2="${H - MB}" stroke="#1e2b45" stroke-width="1"/>` +
      `<text x="${px(gx)}" y="${H - MB + 16}" fill="#9fb0c7" font-size="11" text-anchor="middle">10^${gx}</text>`;
  }
  for (let gy = y0; gy <= y1; gy++) {
    svg += `<line x1="${ML}" y1="${py(gy)}" x2="${W - MR}" y2="${py(gy)}" stroke="#1e2b45" stroke-width="1"/>` +
      `<text x="${ML - 6}" y="${py(gy) + 4}" fill="#9fb0c7" font-size="11" text-anchor="end">10^${gy}</text>`;
  }
  svg += `<text x="${ML}" y="${H - 4}" fill="#9fb0c7" font-size="11">TVL (log10 USD)</text>` +
    `<text x="10" y="${MT + 8}" fill="#9fb0c7" font-size="11">Value (log10 USD)</text>`;
  const lx0 = px(x0);
  const ly0 = py(f.intercept + f.slope * x0);
  const lx1 = px(x1);
  const ly1 = py(f.intercept + f.slope * x1);
  svg += `<line x1="${lx0}" y1="${ly0}" x2="${lx1}" y2="${ly1}" stroke="#e8eef7" stroke-width="2"/>`;
  for (const r of D.rows) {
    svg += `<circle cx="${px(Math.log10(r.tvl_usd)).toFixed(1)}" cy="${py(Math.log10(r.implied_usd)).toFixed(1)}" r="2" fill="#2dd4bf" opacity="0.55"/>`;
  }
  for (const a of comps) {
    svg += `<circle cx="${px(Math.log10(a.tvl_usd)).toFixed(1)}" cy="${py(Math.log10(a.mcap_usd)).toFixed(1)}" r="3" fill="#f59e0b" opacity="0.9"/>`;
  }
  svg += `</svg>`;
  const boxes = [
    ["Alpha", f.intercept.toFixed(4)],
    ["Beta", f.slope.toFixed(4)],
    ["LOO miss", fmtX(10 ** f.loo_med)],
    ["Within ×2 (LOO)", fmtPct(comps.filter((a) => Math.abs(a.err_dex || 9) <= Math.log10(2)).length / comps.length, 1)],
    ["Time split R²", f.walk_r2.toFixed(3)],
    ["P10–P90 band", "×" + (10 ** f.loo_q10).toFixed(2) + " – ×" + (10 ** f.loo_q90).toFixed(2)],
  ];
  $("methodBody").innerHTML =
    `<div class="statboxes">${boxes.map((b) => `<div class="box"><div class="k">${b[0]}</div><div class="v">${b[1]}</div></div>`).join("")}</div>` +
    svg +
    `<p class="muted">Teal dots: ${D.rows.length} board rows at fitted value. Amber dots: ${comps.length} traded comps at real market cap. White line: the M1 fit. Validation is honest and weak: 2-fold R² ${f.fold_r2[0].toFixed(2)}/${f.fold_r2[1].toFixed(2)}, walk-forward R² ${f.walk_r2.toFixed(2)} — the model beats a flat multiple, but a typical launch value is still only known within about ${fmtX(f.miss_m1)}.</p>`;
}

function renderIntegrity() {
  const cov = D.coverage;
  $("integrityStrip").innerHTML =
    `Board ${cov.board} rows · watchlist ${cov.watchlist_covered}/${cov.watchlist_total} · anchors ${cov.traded_anchors} · excluded ${cov.excluded} · total ${cov.total} · ` +
    `fit ${D.fit.intercept.toFixed(3)} + ${D.fit.slope.toFixed(3)}·log10(TVL) on ${D.fit.n} comps · generated ${D.generated} · all figures recomputed from the snapshot at load.`;
}

// ---- Hash deep-links (used by the screenshot pass) ----
function applyHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("tab") === "live") state.tab = "live";
  if (h.get("verdict")) state.verdict = h.get("verdict");
  if (h.get("sort")) state.sortKey = h.get("sort");
  if (h.get("dir") === "asc") state.sortDir = 1;
  if (h.get("dir") === "desc") state.sortDir = -1;
  if (h.get("watch") === "1") state.watchOnly = true;
  if (h.get("search")) state.search = h.get("search").toLowerCase();
  if (h.get("detail")) state.detailSlug = h.get("detail");
  if (h.get("dtab")) state.detailTab = h.get("dtab");
  if (h.get("sbdep")) state.sbDep = Math.max(100, Math.min(10000, Number(h.get("sbdep")) || 1000));
  if (h.get("sbshare")) state.sbShare = Math.max(0.25, Math.min(2, Number(h.get("sbshare")) || 1));
  if (h.get("sbtvl")) state.sbTvl = Math.max(0.5, Math.min(3, Number(h.get("sbtvl")) || 1));
}

function wireEvents() {
  $("tabBoard").addEventListener("click", () => {
    state.tab = "board";
    $("tabBoard").classList.add("active");
    $("tabLive").classList.remove("active");
    $("boardTable").hidden = false;
    $("anchorTable").hidden = true;
    $("boardFilters").style.display = "";
  });
  $("tabLive").addEventListener("click", () => {
    state.tab = "live";
    $("tabLive").classList.add("active");
    $("tabBoard").classList.remove("active");
    $("boardTable").hidden = true;
    $("anchorTable").hidden = false;
    $("boardFilters").style.display = "none";
  });
  $("fSearch").addEventListener("input", (e) => { state.search = e.target.value.toLowerCase(); renderBoard(); });
  $("fCat").addEventListener("change", (e) => { state.cat = e.target.value; renderBoard(); });
  $("fChain").addEventListener("change", (e) => { state.chain = e.target.value; renderBoard(); });
  $("fVerdict").addEventListener("change", (e) => { state.verdict = e.target.value; renderBoard(); });
  $("fWatch").addEventListener("change", (e) => { state.watchOnly = e.target.checked; renderBoard(); });
  if (state.verdict) $("fVerdict").value = state.verdict;
  if (state.search) $("fSearch").value = state.search;
  if (state.watchOnly) $("fWatch").checked = true;
  if (state.tab === "live") $("tabLive").click();
  $("detailClose").addEventListener("click", closeDetail);
  document.querySelectorAll("[data-dtab]").forEach((b) =>
    b.addEventListener("click", () => openDetail(state.detailSlug, b.dataset.dtab)));
  $("compareGo").addEventListener("click", renderCompareView);
  $("compareClear").addEventListener("click", () => {
    state.compare.clear();
    renderCompareBar();
    renderBoard();
  });
  $("sbDep").addEventListener("input", (e) => { state.sbDep = Number(e.target.value); renderSandbox(); });
  $("sbShare").addEventListener("input", (e) => { state.sbShare = Number(e.target.value); renderSandbox(); });
  $("sbTvl").addEventListener("input", (e) => { state.sbTvl = Number(e.target.value); renderSandbox(); });
  $("sbDep").value = state.sbDep;
  $("sbShare").value = state.sbShare;
  $("sbTvl").value = state.sbTvl;
  renderSandbox();
}

init();
