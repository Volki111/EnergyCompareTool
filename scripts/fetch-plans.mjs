#!/usr/bin/env node
/**
 * Fetch electricity plan pricing from the Australian Consumer Data Right (CDR)
 * energy Product Reference Data (PRD) APIs and normalise it into the compact
 * shape the Energy Compare Tool front-end understands.
 *
 * PRD endpoints are public and unauthenticated. Each retailer exposes:
 *   GET {baseUri}/cds-au/v1/energy/plans            (list)
 *   GET {baseUri}/cds-au/v1/energy/plans/{planId}   (full tariff detail)
 *
 * Monetary values in CDR energy are AmountStrings in DOLLARS (per kWh / per
 * day). This app works internally in cents, so every price is multiplied by
 * 100 here.
 *
 * Run: node scripts/fetch-plans.mjs
 * Env:
 *   RETAILERS_FILE  path to seed list (default data/retailers.json)
 *   OUT_FILE        output path (default data/plans.json)
 *   MAX_PLANS       cap total normalised plans (default 600)
 *   MAX_PER_RETAILER cap plans fetched per retailer (default 250)
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import path from "node:path";

const DAY_MAP = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

/* ------------------------------- helpers -------------------------------- */

export function toCents(dollarStr) {
  if (dollarStr === null || dollarStr === undefined || dollarStr === "") return null;
  const v = parseFloat(dollarStr);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100 * 1000) / 1000; // cents, up to 3dp
}

function mapDays(arr) {
  return (arr || []).map((d) => DAY_MAP[d]).filter((d) => d !== undefined);
}

// CDR times are ISO-8601 (e.g. "15:00:00", "1500", "15:00"). Return "HH:MM".
function normTime(t) {
  if (!t) return "00:00";
  let s = String(t).trim().replace(/[Zz].*$/, "").replace(/[+-]\d\d:?\d\d$/, "");
  let h, m;
  if (/^\d{4}$/.test(s)) { h = +s.slice(0, 2); m = +s.slice(2); }
  else { const p = s.split(":"); h = +p[0]; m = +(p[1] || 0); }
  if (!Number.isFinite(h)) h = 0;
  if (!Number.isFinite(m)) m = 0;
  if (h >= 24) h = h % 24; // 24:00 -> 00:00
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function prettyType(t) {
  return ({
    PEAK: "Peak", OFF_PEAK: "Off-peak", SHOULDER: "Shoulder",
    SHOULDER1: "Shoulder 1", SHOULDER2: "Shoulder 2",
  })[t] || (t ? t.replace(/_/g, " ") : "Rate");
}

// Choose the tariff period covering today (mm-dd seasonal windows); fall back
// to the first period.
function pickPeriod(periods) {
  if (periods.length <= 1) return periods[0];
  const now = new Date();
  const md = String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  for (const p of periods) {
    if (!p.startDate || !p.endDate) continue;
    const inRange = p.startDate <= p.endDate
      ? md >= p.startDate && md <= p.endDate
      : md >= p.startDate || md <= p.endDate; // wraps year end
    if (inRange) return p;
  }
  return periods[0];
}

/* --------------------------- normalisation ------------------------------ */

/**
 * Convert one EnergyPlanDetailV3 `data` object into an app plan template, or
 * null if it can't be modelled (e.g. demand-only tariffs, gas-only).
 */
export function normalizePlanDetail(detail) {
  if (!detail) return null;
  const c = detail.electricityContract;
  if (!c) return null; // gas-only / no electricity terms

  const periods = c.tariffPeriod || [];
  if (!periods.length) return null;
  const period = pickPeriod(periods);
  if (!period) return null;

  let supply = toCents(period.dailySupplyCharge);
  if (supply === null && Array.isArray(period.bandedDailySupplyCharges) && period.bandedDailySupplyCharges.length) {
    supply = toCents(period.bandedDailySupplyCharges[0].unitPrice);
  }

  let mode = "flat", flat = null, touDefault = null, windows = [];

  if (period.rateBlockUType === "singleRate") {
    flat = toCents(period.singleRate?.rates?.[0]?.unitPrice);
  } else if (period.rateBlockUType === "timeOfUseRates") {
    mode = "tou";
    const entries = (period.timeOfUseRates || [])
      .map((e) => ({ type: e.type, rate: toCents(e.rates?.[0]?.unitPrice), tou: e.timeOfUse || [] }))
      .filter((e) => e.rate !== null);
    if (!entries.length) return null;
    // The default (uncovered-time) rate is the OFF_PEAK tariff by type — NOT the
    // numeric minimum, which would wrongly promote a free/solar-sponge window to
    // apply all day. Fall back to the lowest rate only if no OFF_PEAK exists.
    let defaultEntry = entries.find((e) => e.type === "OFF_PEAK");
    if (!defaultEntry) defaultEntry = entries.reduce((a, b) => (b.rate < a.rate ? b : a));
    touDefault = defaultEntry.rate;
    // Emit every other period as an explicit window (including free 0c windows).
    for (const e of entries) {
      if (e === defaultEntry) continue;
      for (const w of e.tou) {
        windows.push({
          label: prettyType(e.type), rate: e.rate,
          days: mapDays(w.days), from: normTime(w.startTime), to: normTime(w.endTime),
        });
      }
    }
    if (!windows.length) { mode = "flat"; flat = touDefault; touDefault = null; }
  } else {
    return null; // demandCharges-only: not modelled by this app
  }

  // Controlled load (take the cheapest tier available)
  let controlled = null;
  const cl = (c.controlledLoad || [])[0];
  if (cl) {
    if (cl.rateBlockUType === "singleRate") controlled = toCents(cl.singleRate?.rates?.[0]?.unitPrice);
    else if (cl.rateBlockUType === "timeOfUseRates") {
      const rs = (cl.timeOfUseRates || []).map((e) => toCents(e.rates?.[0]?.unitPrice)).filter((x) => x !== null);
      if (rs.length) controlled = Math.min(...rs);
    }
  }

  // Solar feed-in (first retailer tariff)
  let feedin = null;
  const sfit = (c.solarFeedInTariff || []).find((s) => s.payerType === "RETAILER") || (c.solarFeedInTariff || [])[0];
  if (sfit) {
    if (sfit.tariffUType === "singleTariff") feedin = toCents(sfit.singleTariff?.rates?.[0]?.unitPrice);
    else if (sfit.tariffUType === "timeVaryingTariffs") feedin = toCents(sfit.timeVaryingTariffs?.[0]?.rates?.[0]?.unitPrice);
  }

  // Reject implausible residential values — bad/misaligned data would silently
  // skew comparisons. Bounds are generous vs real-world maxima (supply ~300c/day,
  // usage ~80c/kWh).
  const rateVals = [flat, touDefault, controlled, ...windows.map((w) => w.rate)].filter((v) => v !== null && v !== undefined);
  if (supply !== null && (supply < 0 || supply > 500)) return null;
  if (rateVals.some((v) => v < 0 || v > 250)) return null;
  if (feedin !== null && (feedin < 0 || feedin > 150)) return null;

  const round = (x) => (x === null ? "" : Math.round(x * 100) / 100);
  return {
    source: "cdr",
    planId: detail.planId,
    brand: detail.brandName || detail.brand || "",
    name: detail.displayName || "Plan",
    fuelType: detail.fuelType || "ELECTRICITY",
    customerType: detail.customerType || "RESIDENTIAL",
    distributors: (detail.geography?.distributors) || [],
    applicationUri: detail.applicationUri || "",
    supply: round(supply),
    controlled: round(controlled),
    feedin: round(feedin),
    discount: "",
    mode,
    flat: round(flat),
    touDefault: round(touDefault),
    windows: windows.map((w) => ({ ...w, rate: Math.round(w.rate * 100) / 100 })),
  };
}

/* ------------------------------ fetching -------------------------------- */

// Government CDR endpoints sit behind a WAF that rejects Node's native fetch
// TLS fingerprint (403) but accepts curl, so we shell out to curl. Versions are
// tried high-to-low so we get the richest schema the holder supports (this
// app's normaliser targets the v3 tariff shape).
function curlJson(url, versions = [3, 2, 1]) {
  return new Promise((resolve, reject) => {
    let lastErr = new Error("request failed");
    const attempt = (i) => {
      if (i >= versions.length) return reject(lastErr);
      const v = versions[i];
      execFile("curl", [
        "-sS", "--max-time", "20", "--retry", "1", "--retry-delay", "1",
        "-H", `x-v: ${v}`, "-H", "Accept: application/json",
        "-w", "\n%{http_code}", url,
      ], { maxBuffer: 128 * 1024 * 1024 }, (err, stdout) => {
        if (err) { lastErr = err; return attempt(i + 1); }
        const nl = stdout.lastIndexOf("\n");
        const code = stdout.slice(nl + 1).trim();
        const body = stdout.slice(0, nl);
        if (code !== "200") { lastErr = new Error("HTTP " + code); return attempt(i + 1); }
        try { resolve(JSON.parse(body)); }
        catch (e) { lastErr = e; attempt(i + 1); }
      });
    };
    attempt(0);
  });
}
const fetchJson = curlJson;

function isElectricityResidential(p) {
  const fuel = p.fuelType || "ELECTRICITY";
  const cust = p.customerType || "RESIDENTIAL";
  return (fuel === "ELECTRICITY" || fuel === "DUAL") && cust === "RESIDENTIAL";
}

async function listPlans(baseUri) {
  const out = [];
  let page = 1, totalPages = 1;
  do {
    const url = `${baseUri}/cds-au/v1/energy/plans?page=${page}&page-size=1000&type=ALL&fuelType=ELECTRICITY&effective=CURRENT`;
    const json = await fetchJson(url, [1, 2, 3]);
    const plans = json?.data?.plans || [];
    for (const p of plans) if (isElectricityResidential(p)) out.push(p);
    totalPages = json?.meta?.totalPages || 1;
    page++;
  } while (page <= totalPages && page <= 20);
  return out;
}

// Community-maintained reconstruction of the CDR Register that (unlike the
// official register's publicBaseUri) exposes each brand's actual
// productReferenceDataBaseUri — the correct base for the plans endpoints. This
// is the most complete discovery source; the register is used as a fallback.
const COMMUNITY_PRD_URL = process.env.COMMUNITY_PRD_URL ||
  "https://raw.githubusercontent.com/jxeeno/energy-cdr-prd-endpoints/main/docs/energy-prd-endpoints.json";

async function fetchCommunityEndpoints() {
  try {
    const json = await curlJson(COMMUNITY_PRD_URL, [1]);
    const rows = Array.isArray(json) ? json : json?.data || [];
    return rows
      .map((b) => ({ name: b.brandName, baseUri: (b.productReferenceDataBaseUri || "").replace(/\/+$/, "") }))
      .filter((b) => b.baseUri);
  } catch (e) {
    console.warn("Community endpoint list failed:", e.message || e);
    return [];
  }
}

// Fallback discovery from the official CDR Register. Its publicBaseUri is the
// correct product base for Energy Made Easy-hosted brands but 404s for
// self-hosters (dropped by the pre-probe).
async function fetchRegisterEndpoints() {
  try {
    const json = await curlJson(
      "https://api.cdr.gov.au/cdr-register/v1/energy/data-holders/brands/summary",
      [2, 1]
    );
    return (json?.data || [])
      .map((b) => ({ name: b.brandName, baseUri: (b.publicBaseUri || "").replace(/\/+$/, "") }))
      .filter((b) => b.baseUri);
  } catch (e) {
    console.warn("Register discovery failed:", e.message || e);
    return [];
  }
}

// Fast, parallel liveness check: does this base serve residential electricity
// plans? Returns totalRecords (0 if not usable).
function probeBase(baseUri) {
  return new Promise((resolve) => {
    execFile("curl", [
      "-sS", "--max-time", "8", "-H", "x-v: 1", "-o", "-", "-w", "\n%{http_code}",
      `${baseUri}/cds-au/v1/energy/plans?page-size=1&type=ALL&fuelType=ELECTRICITY`,
    ], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(0);
      const nl = out.lastIndexOf("\n");
      if (out.slice(nl + 1).trim() !== "200") return resolve(0);
      try { resolve(JSON.parse(out.slice(0, nl))?.meta?.totalRecords || 0); }
      catch { resolve(0); }
    });
  });
}

async function pool(items, size, worker) {
  const results = [];
  let i = 0;
  const runners = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await worker(items[idx]); } catch (e) { results[idx] = null; }
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const RETAILERS_FILE = process.env.RETAILERS_FILE || "data/retailers.json";
  const OUT_FILE = process.env.OUT_FILE || "data/plans.json";
  const MAX_PLANS = +(process.env.MAX_PLANS || 600);
  const MAX_PER_RETAILER = +(process.env.MAX_PER_RETAILER || 250);

  const retailers = JSON.parse(await readFile(RETAILERS_FILE, "utf8"));
  const seed = Array.isArray(retailers) ? retailers : retailers.retailers || [];
  console.log(`Loaded ${seed.length} seed endpoints from ${RETAILERS_FILE}`);

  // Merge the curated seed with dynamic register discovery, de-duplicated by
  // base URI. The seed carries the majors (AGL, Origin…) whose register entry
  // points at a self-host URL that 404s; discovery adds everything else.
  let candidates = seed.slice();
  const have = new Set(seed.map((s) => (s.baseUri || "").replace(/\/+$/, "")));
  const addAll = (rows) => { for (const r of rows) if (r.baseUri && !have.has(r.baseUri)) { candidates.push(r); have.add(r.baseUri); } };
  if (process.env.USE_DISCOVERY !== "0") {
    const community = await fetchCommunityEndpoints();
    console.log(`Community list returned ${community.length} product endpoints`);
    addAll(community);
    const reg = await fetchRegisterEndpoints();
    console.log(`Register returned ${reg.length} brand endpoints`);
    addAll(reg);
  }
  console.log(`Pre-probing ${candidates.length} candidate endpoints…`);
  const totals = await pool(candidates, 12, async (c) => probeBase((c.baseUri || "").replace(/\/+$/, "")));
  const list = candidates.filter((_, i) => totals[i] > 0);
  console.log(`${list.length} endpoints serve residential electricity plans.`);

  const allPlans = [];
  const report = [];
  for (const r of list) {
    const base = (r.baseUri || "").replace(/\/+$/, "");
    if (!base) continue;
    try {
      const metas = await listPlans(base);
      const capped = metas.slice(0, MAX_PER_RETAILER);
      const details = await pool(capped, 6, async (p) => {
        const json = await fetchJson(`${base}/cds-au/v1/energy/plans/${encodeURIComponent(p.planId)}`, [3, 2, 1]);
        return normalizePlanDetail(json?.data);
      });
      const good = details.filter(Boolean);
      good.forEach((g) => (g.retailer = r.name || g.brand));
      allPlans.push(...good);
      report.push({ retailer: r.name || base, listed: metas.length, normalised: good.length });
      console.log(`  ${r.name || base}: ${metas.length} listed, ${good.length} usable`);
    } catch (e) {
      report.push({ retailer: r.name || base, error: String(e.message || e) });
      console.warn(`  ${r.name || base}: FAILED (${e.message || e})`);
    }
    if (allPlans.length >= MAX_PLANS) break;
  }

  // De-duplicate by planId (alias endpoints / dual listings can repeat plans).
  const seen = new Set();
  const deduped = allPlans.filter((p) => {
    const key = p.planId || JSON.stringify(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const plans = deduped.slice(0, MAX_PLANS);
  // Distinct distributor list for the front-end filter.
  const distributors = [...new Set(plans.flatMap((p) => p.distributors))].filter(Boolean).sort();

  const output = {
    generatedAt: new Date().toISOString(),
    source: "Australian CDR energy Product Reference Data",
    disclaimer: "List/market rates for residential electricity, GST-inclusive figures may vary. Estimates only — always confirm on the retailer's site.",
    planCount: plans.length,
    distributors,
    retailers: report,
    plans,
  };
  // Compact JSON — this file is fetched by the browser on every visit, so keep
  // it small. (It's machine-generated; line-level diffs aren't meaningful.)
  await writeFile(OUT_FILE, JSON.stringify(output) + "\n");
  console.log(`Wrote ${plans.length} plans (${distributors.length} distributors) to ${OUT_FILE}`);
}

// Run main() only when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
