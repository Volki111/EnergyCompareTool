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
    touDefault = Math.min(...entries.map((e) => e.rate));
    for (const e of entries) {
      if (e.rate <= touDefault) continue; // off-peak is covered by the default
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

async function fetchJson(url, versions = [3, 2, 1]) {
  let lastErr;
  for (const v of versions) {
    try {
      const res = await fetch(url, { headers: { "x-v": String(v), "Accept": "application/json" } });
      if (res.status === 406) continue; // unsupported version; try another
      if (!res.ok) { lastErr = new Error("HTTP " + res.status); continue; }
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("request failed");
}

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
  const list = Array.isArray(retailers) ? retailers : retailers.retailers || [];
  console.log(`Loaded ${list.length} retailer endpoints from ${RETAILERS_FILE}`);

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

  const plans = allPlans.slice(0, MAX_PLANS);
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
  await writeFile(OUT_FILE, JSON.stringify(output, null, 2) + "\n");
  console.log(`Wrote ${plans.length} plans (${distributors.length} distributors) to ${OUT_FILE}`);
}

// Run main() only when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
