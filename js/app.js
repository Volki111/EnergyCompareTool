/* Energy Compare Tool
 * Everything runs client-side. No data leaves the browser.
 *
 * Data model:
 *   intervals: [{ start: Date, minutes: number, register: 'general'|'controlled', kwh: number }]
 *   plan: {
 *     id, name, supply (c/day), controlled (c/kWh|null), feedin (c/kWh|null),
 *     discount (%), mode: 'flat'|'tou', flat (c/kWh),
 *     touDefault (c/kWh), windows: [{ label, rate, days:[0-6], from:'HH:MM', to:'HH:MM' }]
 *   }
 */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let intervals = [];   // parsed usage
  let usageStats = null; // computed summary
  let plans = [];        // user plans
  let profileChart = null;
  let compareChart = null;
  let breakdownChart = null;
  let monthlyChart = null;
  let costProfileChart = null;
  let tierChart = null;
  let planSeq = 0;
  let lastResults = [];       // most recent [{plan, cost}] sorted cheapest-first
  let costProfilePlanId = null; // plan selected in the usage-vs-cost chart
  let optPlanId = null;         // plan selected in the load-shift optimiser
  let optPct = 30;              // load-shift slider position
  let nmiNetworks = null;       // AEMO NMI allocation table
  let detectedNmi = null;       // NMI read from the uploaded file
  let detectedNetwork = null;   // { name, region } matched from the NMI

  const STORAGE_KEY = "ect_plans_v1";

  /* ------------------------------------------------------------------ */
  /* CSV parsing                                                         */
  /* ------------------------------------------------------------------ */

  // Minimal CSV line splitter (handles quoted fields with commas)
  function splitCsvLine(line) {
    const out = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  // Parse "11/08/2025 12:00:00 AM" (DD/MM/YYYY 12h) -> Date. Also tolerates
  // ISO-ish and 24h formats as a fallback.
  function parseDate(str) {
    if (!str) return null;
    str = str.trim();
    // DD/MM/YYYY optional time with optional AM/PM
    let m = str.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i
    );
    if (m) {
      let [, dd, mm, yyyy, hh, mi, ss, ap] = m;
      dd = +dd; mm = +mm; yyyy = +yyyy;
      hh = hh ? +hh : 0; mi = mi ? +mi : 0; ss = ss ? +ss : 0;
      if (ap) {
        ap = ap.toUpperCase();
        if (ap === "PM" && hh < 12) hh += 12;
        if (ap === "AM" && hh === 12) hh = 0;
      }
      return new Date(yyyy, mm - 1, dd, hh, mi, ss);
    }
    // ISO fallback
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  function classifyRegister(rateDesc, registerCode) {
    const s = ((rateDesc || "") + " " + (registerCode || "")).toLowerCase();
    if (s.includes("control") || s.includes("offpeak") || s.includes("off-peak") || s.includes("#002"))
      return "controlled";
    return "general";
  }

  function parseCsv(text) {
    const lines = text.split(/\r\n|\n|\r/).filter((l) => l.length);
    if (!lines.length) throw new Error("The file appears to be empty.");
    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, ""));

    const idx = (names) => {
      for (const n of names) {
        const i = header.indexOf(n);
        if (i !== -1) return i;
      }
      return -1;
    };

    const iStart = idx(["startdate", "start", "intervaldate", "readingstartdate", "datetime", "timestamp"]);
    const iEnd = idx(["enddate", "end"]);
    const iProfile = idx(["profilereadvalue", "usage", "kwh", "consumption", "value", "quantity"]);
    const iRegisterRead = idx(["registerreadvalue"]);
    const iRateDesc = idx(["ratetypedescription", "ratetype", "description"]);
    const iRegCode = idx(["registercode", "register"]);
    const iNmi = idx(["nmi"]);

    if (iStart === -1) throw new Error("Couldn't find a start-date/time column. Expected a column like 'StartDate'.");
    const iValue = iProfile !== -1 ? iProfile : iRegisterRead;
    if (iValue === -1) throw new Error("Couldn't find a usage value column (e.g. 'ProfileReadValue').");

    const rows = [];
    let skipped = 0;
    detectedNmi = null;
    for (let i = 1; i < lines.length; i++) {
      const c = splitCsvLine(lines[i]);
      if (c.length <= iValue) { skipped++; continue; }
      if (!detectedNmi && iNmi !== -1 && c[iNmi]) detectedNmi = c[iNmi].trim();
      const start = parseDate(c[iStart]);
      const kwh = parseFloat(c[iValue]);
      if (!start || isNaN(kwh)) { skipped++; continue; }
      let minutes = 30;
      if (iEnd !== -1) {
        const end = parseDate(c[iEnd]);
        if (end) {
          const diff = Math.round((end - start) / 60000) + 1; // exports use 12:00–12:29:59
          if (diff > 0 && diff <= 120) minutes = diff <= 31 ? 30 : diff;
        }
      }
      rows.push({
        start,
        minutes,
        register: classifyRegister(iRateDesc !== -1 ? c[iRateDesc] : "", iRegCode !== -1 ? c[iRegCode] : ""),
        kwh,
      });
    }
    if (!rows.length) throw new Error("No usable rows found. Is this an interval usage export?");
    rows.sort((a, b) => a.start - b.start);
    return { rows, skipped };
  }

  /* ------------------------------------------------------------------ */
  /* Usage stats                                                         */
  /* ------------------------------------------------------------------ */

  function computeStats(rows) {
    let generalKwh = 0, controlledKwh = 0, exportKwh = 0;
    const dayset = new Set();
    // profile[register][halfhour 0..47] = sum kwh
    const profile = { general: new Array(48).fill(0), controlled: new Array(48).fill(0) };
    // heatmap[day 0..6][hour 0..23] = sum kwh (general+controlled)
    const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));

    for (const r of rows) {
      const d = r.start;
      dayset.add(d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate());
      if (r.kwh < 0) exportKwh += -r.kwh;
      else if (r.register === "controlled") controlledKwh += r.kwh;
      else generalKwh += r.kwh;

      const hh = d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0);
      profile[r.register][hh] += Math.max(0, r.kwh);
      heat[d.getDay()][d.getHours()] += Math.max(0, r.kwh);
    }

    const first = rows[0].start, last = rows[rows.length - 1].start;
    const spanDays = Math.max(1, Math.round((last - first) / 86400000) + 1);
    const nDays = dayset.size || spanDays;

    // Average per half-hour slot (divide by number of days observed)
    const avgProfile = {
      general: profile.general.map((v) => v / nDays),
      controlled: profile.controlled.map((v) => v / nDays),
    };
    // Average heat per (day,hour): divide by number of that weekday observed
    const weekdayCounts = new Array(7).fill(0);
    for (const key of dayset) {
      const [y, mo, da] = key.split("-").map(Number);
      weekdayCounts[new Date(y, mo, da).getDay()]++;
    }
    const avgHeat = heat.map((row, dow) =>
      row.map((v) => (weekdayCounts[dow] ? v / weekdayCounts[dow] : 0))
    );

    return {
      generalKwh, controlledKwh, exportKwh,
      totalKwh: generalKwh + controlledKwh,
      first, last, nDays, spanDays,
      avgProfile, avgHeat,
      avgDailyKwh: (generalKwh + controlledKwh) / nDays,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Cost calculation                                                    */
  /* ------------------------------------------------------------------ */

  function toMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

  function windowMatches(win, date) {
    if (win.days && win.days.length && !win.days.includes(date.getDay())) return false;
    const cur = date.getHours() * 60 + date.getMinutes();
    const from = toMin(win.from), to = toMin(win.to);
    if (from === to) return true;                 // whole day
    if (from < to) return cur >= from && cur < to; // same-day window
    return cur >= from || cur < to;                // wraps past midnight
  }

  function rateForInterval(plan, r) {
    if (r.register === "controlled" && plan.controlled != null && plan.controlled !== "")
      return num(plan.controlled);
    if (plan.mode === "flat") return num(plan.flat);
    for (const w of plan.windows) {
      if (w.rate === "" || w.rate == null) continue;
      if (windowMatches(w, r.start)) return num(w.rate);
    }
    return num(plan.touDefault);
  }

  function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

  // Returns cost breakdown in dollars over the whole uploaded period.
  function costForPlan(plan, rows, stats) {
    let usageCents = 0, controlledCents = 0, feedinCents = 0;
    for (const r of rows) {
      if (r.kwh < 0) {
        feedinCents += (-r.kwh) * num(plan.feedin);
        continue;
      }
      const rate = rateForInterval(plan, r);
      if (r.register === "controlled") controlledCents += r.kwh * rate;
      else usageCents += r.kwh * rate;
    }
    const disc = num(plan.discount) / 100;
    usageCents *= 1 - disc;
    controlledCents *= 1 - disc;
    const supplyCents = stats.nDays * num(plan.supply);
    const totalCents = usageCents + controlledCents + supplyCents - feedinCents;

    const perYear = (totalCents / 100) * (365 / stats.nDays);
    return {
      usage: usageCents / 100,
      controlled: controlledCents / 100,
      supply: supplyCents / 100,
      feedin: feedinCents / 100,
      total: totalCents / 100,
      perDay: totalCents / 100 / stats.nDays,
      perYear,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: usage                                                    */
  /* ------------------------------------------------------------------ */

  function fmt(n, d = 0) {
    return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function money(n) {
    return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function renderUsage() {
    const s = usageStats;
    $("#step-usage").hidden = false;
    $("#step-plans").hidden = false;

    const dRange = s.first.toLocaleDateString() + " → " + s.last.toLocaleDateString();
    const stats = [
      ["Total usage", fmt(s.totalKwh, 0) + " kWh", dRange],
      ["General usage", fmt(s.generalKwh, 0) + " kWh", "main tariff"],
      ["Controlled load", fmt(s.controlledKwh, 0) + " kWh", s.controlledKwh > 0 ? "e.g. hot water" : "none detected"],
      ["Days of data", fmt(s.nDays, 0), "used for scaling"],
      ["Avg per day", fmt(s.avgDailyKwh, 1) + " kWh", "across all usage"],
    ];
    if (s.exportKwh > 0) stats.push(["Solar export", fmt(s.exportKwh, 0) + " kWh", "exported to grid"]);

    $("#stat-grid").innerHTML = stats
      .map(([lbl, num, sub]) => `<div class="stat"><div class="num">${num}</div><div class="lbl">${lbl}</div><div class="lbl">${sub}</div></div>`)
      .join("");

    safe(renderProfileChart);
    safe(renderHeatmap);
  }

  // Run a rendering fn without letting a failure (e.g. charts unavailable)
  // break the rest of the app.
  function safe(fn) {
    try { fn(); } catch (e) { console.warn("render skipped:", e && e.message); }
  }
  const hasChart = () => typeof Chart !== "undefined";

  function renderProfileChart() {
    if (!hasChart()) return;
    const s = usageStats;
    const labels = Array.from({ length: 48 }, (_, i) => {
      const h = Math.floor(i / 2), m = i % 2 ? "30" : "00";
      return (h % 6 === 0 && m === "00") ? `${String(h).padStart(2, "0")}:00` : "";
    });
    const ctx = $("#profile-chart");
    if (profileChart) profileChart.destroy();
    const ds = [{
      label: "General usage",
      data: s.avgProfile.general,
      borderColor: "#ffb703",
      backgroundColor: "rgba(255,183,3,.15)",
      fill: true, tension: .3, pointRadius: 0, borderWidth: 2,
    }];
    if (s.controlledKwh > 0) {
      ds.push({
        label: "Controlled load",
        data: s.avgProfile.controlled,
        borderColor: "#4ea8de",
        backgroundColor: "rgba(78,168,222,.12)",
        fill: true, tension: .3, pointRadius: 0, borderWidth: 2,
      });
    }
    profileChart = new Chart(ctx, {
      type: "line",
      data: { labels, datasets: ds },
      options: chartOpts("kWh", "Time of day"),
    });
  }

  function heatColor(t) {
    // t in 0..1 -> blend bg-elev to accent
    const a = [30, 42, 55], b = [255, 183, 3];
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  function renderHeatmap() {
    const s = usageStats;
    let max = 0;
    for (const row of s.avgHeat) for (const v of row) if (v > max) max = v;
    max = max || 1;
    const el = $("#heatmap");
    let html = '<div class="hm-label"></div>';
    for (let h = 0; h < 24; h++) html += `<div class="hm-hour">${h % 3 === 0 ? h : ""}</div>`;
    for (let d = 1; d <= 7; d++) {
      const dow = d % 7; // start Monday
      html += `<div class="hm-label">${DOW[dow]}</div>`;
      for (let h = 0; h < 24; h++) {
        const v = s.avgHeat[dow][h];
        html += `<div class="hm-cell" style="background:${heatColor(v / max)}" title="${DOW[dow]} ${h}:00 — ${v.toFixed(2)} kWh avg"></div>`;
      }
    }
    el.innerHTML = html;
  }

  function chartOpts(yLabel, xLabel) {
    const dim = getComputedStyle(document.body).getPropertyValue("--text-dim").trim() || "#888";
    const grid = "rgba(128,128,128,.15)";
    return {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: dim } } },
      scales: {
        x: { title: { display: !!xLabel, text: xLabel, color: dim }, ticks: { color: dim, maxRotation: 0, autoSkip: true }, grid: { color: grid } },
        y: { title: { display: !!yLabel, text: yLabel, color: dim }, ticks: { color: dim }, grid: { color: grid }, beginAtZero: true },
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: plans                                                    */
  /* ------------------------------------------------------------------ */

  function newPlan(tou) {
    return {
      id: ++planSeq,
      name: tou ? "Time-of-use plan" : "Plan " + (plans.length + 1),
      supply: "", controlled: "", feedin: "", discount: "",
      mode: tou ? "tou" : "flat",
      flat: "", touDefault: "",
      windows: tou ? [
        { label: "Peak", rate: "", days: [1, 2, 3, 4, 5], from: "15:00", to: "21:00" },
        { label: "Shoulder", rate: "", days: [1, 2, 3, 4, 5], from: "07:00", to: "15:00" },
      ] : [],
    };
  }

  function addPlan(tou) {
    plans.push(newPlan(tou));
    renderPlans();
    savePlans();
    recompute();
  }

  function renderPlans() {
    const container = $("#plans-container");
    container.innerHTML = "";
    const tmpl = $("#plan-template");
    const rowTmpl = $("#tou-row-template");

    plans.forEach((plan) => {
      const node = tmpl.content.firstElementChild.cloneNode(true);
      node.dataset.planId = plan.id;
      $(".plan-name", node).value = plan.name;
      $(".p-supply", node).value = plan.supply;
      $(".p-controlled", node).value = plan.controlled;
      $(".p-feedin", node).value = plan.feedin;
      $(".p-discount", node).value = plan.discount;
      $(".p-flat", node).value = plan.flat;
      $(".p-tou-default", node).value = plan.touDefault;

      const flatRadio = $(".mode-flat", node), touRadio = $(".mode-tou", node);
      // radios share name="mode" in template; make unique per plan
      flatRadio.name = touRadio.name = "mode-" + plan.id;
      flatRadio.checked = plan.mode === "flat";
      touRadio.checked = plan.mode === "tou";
      $(".flat-block", node).hidden = plan.mode !== "flat";
      $(".tou-block", node).hidden = plan.mode !== "tou";

      const tbody = $(".tou-rows", node);
      plan.windows.forEach((w) => tbody.appendChild(buildWindowRow(rowTmpl, w)));

      wirePlanNode(node, plan);
      container.appendChild(node);
    });
  }

  function buildWindowRow(rowTmpl, w) {
    const tr = rowTmpl.content.firstElementChild.cloneNode(true);
    $(".w-label", tr).value = w.label || "";
    $(".w-rate", tr).value = w.rate;
    $(".w-from", tr).value = w.from || "00:00";
    $(".w-to", tr).value = w.to || "00:00";
    $$(".w-day", tr).forEach((cb) => { cb.checked = (w.days || []).includes(+cb.value); });
    return tr;
  }

  function wirePlanNode(node, plan) {
    const sync = () => { readPlanFromNode(node, plan); savePlans(); recompute(); };

    $(".plan-name", node).addEventListener("input", sync);
    ["p-supply", "p-controlled", "p-feedin", "p-discount", "p-flat", "p-tou-default"]
      .forEach((c) => $("." + c, node).addEventListener("input", sync));

    $(".mode-flat", node).addEventListener("change", () => {
      plan.mode = "flat";
      $(".flat-block", node).hidden = false;
      $(".tou-block", node).hidden = true;
      sync();
    });
    $(".mode-tou", node).addEventListener("change", () => {
      plan.mode = "tou";
      $(".flat-block", node).hidden = true;
      $(".tou-block", node).hidden = false;
      if (!plan.windows.length) {
        plan.windows.push({ label: "Peak", rate: "", days: [1, 2, 3, 4, 5], from: "15:00", to: "21:00" });
        $(".tou-rows", node).appendChild(buildWindowRow($("#tou-row-template"), plan.windows[0]));
        wireWindowRows(node, plan);
      }
      sync();
    });

    $(".remove-plan", node).addEventListener("click", () => {
      plans = plans.filter((p) => p.id !== plan.id);
      renderPlans(); savePlans(); recompute();
    });

    $(".add-window", node).addEventListener("click", () => {
      const w = { label: "", rate: "", days: [1, 2, 3, 4, 5], from: "00:00", to: "06:00" };
      plan.windows.push(w);
      $(".tou-rows", node).appendChild(buildWindowRow($("#tou-row-template"), w));
      wireWindowRows(node, plan);
      sync();
    });

    wireWindowRows(node, plan);
  }

  function wireWindowRows(node, plan) {
    $$(".tou-row", node).forEach((tr, i) => {
      if (tr.dataset.wired) return;
      tr.dataset.wired = "1";
      const sync = () => { readPlanFromNode(node, plan); savePlans(); recompute(); };
      $$("input", tr).forEach((inp) => inp.addEventListener("input", sync));
      $(".remove-window", tr).addEventListener("click", () => {
        const rowIndex = $$(".tou-row", node).indexOf(tr);
        plan.windows.splice(rowIndex, 1);
        tr.remove();
        sync();
      });
    });
  }

  function readPlanFromNode(node, plan) {
    plan.name = $(".plan-name", node).value;
    plan.supply = $(".p-supply", node).value;
    plan.controlled = $(".p-controlled", node).value;
    plan.feedin = $(".p-feedin", node).value;
    plan.discount = $(".p-discount", node).value;
    plan.flat = $(".p-flat", node).value;
    plan.touDefault = $(".p-tou-default", node).value;
    plan.mode = $(".mode-tou", node).checked ? "tou" : "flat";
    plan.windows = $$(".tou-row", node).map((tr) => ({
      label: $(".w-label", tr).value,
      rate: $(".w-rate", tr).value,
      days: $$(".w-day", tr).filter((cb) => cb.checked).map((cb) => +cb.value),
      from: $(".w-from", tr).value || "00:00",
      to: $(".w-to", tr).value || "00:00",
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: results                                                  */
  /* ------------------------------------------------------------------ */

  function planHasRates(p) {
    if (p.mode === "flat") return num(p.flat) > 0 || num(p.supply) > 0;
    return num(p.touDefault) > 0 || p.windows.some((w) => num(w.rate) > 0) || num(p.supply) > 0;
  }

  function recompute() {
    if (!intervals.length) return;
    const usable = plans.filter(planHasRates);
    const resultsSection = $("#step-results");

    if (!usable.length) {
      resultsSection.hidden = false;
      $("#step-optimize").hidden = true;
      $("#verdict").className = "verdict none";
      $("#verdict").innerHTML = "<p>Enter rates for at least one plan above to see the comparison.</p>";
      $("#results-table-wrap").innerHTML = "";
      lastResults = [];
      [compareChart, breakdownChart, monthlyChart, costProfileChart].forEach((c) => c && c.destroy());
      compareChart = breakdownChart = monthlyChart = costProfileChart = null;
      return;
    }

    const results = usable.map((p) => ({ plan: p, cost: costForPlan(p, intervals, usageStats) }));
    results.sort((a, b) => a.cost.perYear - b.cost.perYear);
    lastResults = results;
    const cheapest = results[0], dearest = results[results.length - 1];

    resultsSection.hidden = false;
    const v = $("#verdict");
    v.className = "verdict";
    if (results.length === 1) {
      v.innerHTML = `<h3>${escapeHtml(cheapest.plan.name)}</h3><p>Estimated <span class="save">${money(cheapest.cost.perYear)}/year</span> (${money(cheapest.cost.perDay)}/day) for your usage. Add another plan to compare.</p>`;
    } else {
      const saving = dearest.cost.perYear - cheapest.cost.perYear;
      v.innerHTML = `<h3>${escapeHtml(cheapest.plan.name)} is cheapest</h3>
        <p>Estimated <span class="save">${money(cheapest.cost.perYear)}/year</span> — that's <span class="save">${money(saving)}/year cheaper</span> than the most expensive option (${escapeHtml(dearest.plan.name)}).</p>`;
    }

    renderResultsTable(results, cheapest);
    renderCompareChart(results, cheapest);
    safe(() => renderBreakdownChart(results));
    safe(() => renderMonthlyChart(results));
    safe(renderCostProfile);
    safe(renderOptimize);
  }

  const annualFactor = () => 365 / usageStats.nDays;

  function renderResultsTable(results, cheapest) {
    let html = `<table class="results"><thead><tr>
      <th>Plan</th><th>General usage</th><th>Controlled</th><th>Supply</th><th>Solar credit</th>
      <th>Est. / year</th><th>Est. / day</th></tr></thead><tbody>`;
    for (const r of results) {
      const c = r.cost;
      html += `<tr class="${r === cheapest ? "winner" : ""}">
        <td>${escapeHtml(r.plan.name)}</td>
        <td>${money(c.usage)}</td>
        <td>${c.controlled ? money(c.controlled) : "—"}</td>
        <td>${money(c.supply)}</td>
        <td>${c.feedin ? "-" + money(c.feedin) : "—"}</td>
        <td><strong>${money(c.perYear)}</strong></td>
        <td>${money(c.perDay)}</td></tr>`;
    }
    html += "</tbody></table>";
    $("#results-table-wrap").innerHTML = html;
  }

  function renderCompareChart(results, cheapest) {
    if (!hasChart()) return;
    const ctx = $("#compare-chart");
    if (compareChart) compareChart.destroy();
    compareChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: results.map((r) => r.plan.name),
        datasets: [{
          label: "Estimated annual cost",
          data: results.map((r) => +r.cost.perYear.toFixed(2)),
          backgroundColor: results.map((r) => (r === cheapest ? "#52b788" : "#4ea8de")),
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => money(c.parsed.y) + " / year" } },
        },
        scales: (function () {
          const o = chartOpts("$ per year", "");
          o.scales.y.ticks.callback = (v) => "$" + v;
          return o.scales;
        })(),
      },
    });
  }

  /* ---- Cost breakdown (stacked components) ---- */
  function renderBreakdownChart(results) {
    if (!hasChart()) return;
    const f = annualFactor();
    const ds = [
      { label: "General usage", key: "usage", color: "#ffb703", sign: 1 },
      { label: "Controlled load", key: "controlled", color: "#4ea8de", sign: 1 },
      { label: "Supply charge", key: "supply", color: "#9b8cff", sign: 1 },
      { label: "Solar credit", key: "feedin", color: "#52b788", sign: -1 },
    ].map((d) => ({
      label: d.label,
      data: results.map((r) => +(r.cost[d.key] * f * d.sign).toFixed(2)),
      backgroundColor: d.color,
      borderRadius: 4,
      stack: "cost",
    }));
    if (breakdownChart) breakdownChart.destroy();
    breakdownChart = new Chart($("#breakdown-chart"), {
      type: "bar",
      data: { labels: results.map((r) => r.plan.name), datasets: ds },
      options: (function () {
        const o = chartOpts("$ per year", "");
        o.plugins.tooltip = { callbacks: { label: (c) => c.dataset.label + ": " + money(c.parsed.y) } };
        o.scales.x.stacked = true; o.scales.y.stacked = true;
        o.scales.y.ticks.callback = (v) => "$" + v;
        return { responsive: true, plugins: o.plugins, scales: o.scales };
      })(),
    });
  }

  /* ---- Cost by month, per plan ---- */
  function monthlyCostSeries(plan) {
    // Group intervals by calendar month; supply charge uses distinct days per month.
    const disc = 1 - num(plan.discount) / 100;
    const map = new Map(); // ym -> {usage, controlled, feedin, days:Set}
    for (const r of intervals) {
      const d = r.start;
      const ym = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      let m = map.get(ym);
      if (!m) { m = { usage: 0, controlled: 0, feedin: 0, days: new Set() }; map.set(ym, m); }
      m.days.add(d.getDate());
      if (r.kwh < 0) { m.feedin += -r.kwh * num(plan.feedin); continue; }
      const rate = rateForInterval(plan, r);
      if (r.register === "controlled") m.controlled += r.kwh * rate;
      else m.usage += r.kwh * rate;
    }
    return [...map.keys()].sort().map((ym) => {
      const m = map.get(ym);
      const cents = (m.usage + m.controlled) * disc + m.days.size * num(plan.supply) - m.feedin;
      return { ym, cost: cents / 100 };
    });
  }

  function renderMonthlyChart(results) {
    if (!hasChart()) return;
    const palette = ["#ffb703", "#4ea8de", "#52b788", "#e07a5f", "#9b8cff", "#f4a261", "#2a9d8f", "#e76f51"];
    const seriesList = results.map((r) => monthlyCostSeries(r.plan));
    const labels = [...new Set(seriesList.flat().map((p) => p.ym))].sort();
    const fmtMonth = (ym) => {
      const [y, mo] = ym.split("-");
      return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    };
    const datasets = results.map((r, i) => {
      const byYm = Object.fromEntries(seriesList[i].map((p) => [p.ym, p.cost]));
      return {
        label: r.plan.name,
        data: labels.map((ym) => (ym in byYm ? +byYm[ym].toFixed(2) : null)),
        borderColor: palette[i % palette.length],
        backgroundColor: palette[i % palette.length],
        tension: .3, pointRadius: 2, borderWidth: 2, spanGaps: true,
      };
    });
    if (monthlyChart) monthlyChart.destroy();
    monthlyChart = new Chart($("#monthly-chart"), {
      type: "line",
      data: { labels: labels.map(fmtMonth), datasets },
      options: (function () {
        const o = chartOpts("$ per month", "");
        o.plugins.tooltip = { callbacks: { label: (c) => c.dataset.label + ": " + money(c.parsed.y) } };
        o.scales.y.ticks.callback = (v) => "$" + v;
        return { responsive: true, interaction: { mode: "index", intersect: false }, plugins: o.plugins, scales: o.scales };
      })(),
    });
  }

  /* ---- Usage vs cost by time of day, for a selected plan ---- */
  function costProfileFor(plan) {
    // Average $ spent and kWh used per half-hour slot across an average day.
    const disc = 1 - num(plan.discount) / 100;
    const cost = new Array(48).fill(0);   // cents summed
    const kwh = new Array(48).fill(0);
    for (const r of intervals) {
      if (r.kwh < 0) continue;
      const d = r.start;
      const slot = d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0);
      const rate = rateForInterval(plan, r);
      cost[slot] += r.kwh * rate * disc;
      kwh[slot] += r.kwh;
    }
    const n = usageStats.nDays;
    return { cost: cost.map((c) => c / 100 / n), kwh: kwh.map((k) => k / n) };
  }

  function populateSelect(sel, results, current) {
    const ids = results.map((r) => r.plan.id);
    const chosen = ids.includes(current) ? current : ids[0];
    sel.innerHTML = results
      .map((r) => `<option value="${r.plan.id}"${r.plan.id === chosen ? " selected" : ""}>${escapeHtml(r.plan.name || "Unnamed plan")}</option>`)
      .join("");
    return chosen;
  }

  function renderCostProfile() {
    if (!hasChart() || !lastResults.length) return;
    costProfilePlanId = populateSelect($("#profile-plan"), lastResults, costProfilePlanId);
    const res = lastResults.find((r) => r.plan.id === costProfilePlanId);
    if (!res) return;
    const prof = costProfileFor(res.plan);
    const labels = Array.from({ length: 48 }, (_, i) => {
      const h = Math.floor(i / 2), m = i % 2 ? "30" : "00";
      return (h % 3 === 0 && m === "00") ? `${String(h).padStart(2, "0")}:00` : "";
    });
    if (costProfileChart) costProfileChart.destroy();
    const dim = getComputedStyle(document.body).getPropertyValue("--text-dim").trim() || "#888";
    costProfileChart = new Chart($("#cost-profile-chart"), {
      data: {
        labels,
        datasets: [
          {
            type: "bar", label: "Cost (¢/half-hour)", yAxisID: "yCost",
            data: prof.cost.map((c) => +(c * 100).toFixed(2)),
            backgroundColor: "rgba(224,122,95,.65)", borderRadius: 2,
          },
          {
            type: "line", label: "Usage (kWh)", yAxisID: "yKwh",
            data: prof.kwh.map((k) => +k.toFixed(3)),
            borderColor: "#4ea8de", backgroundColor: "rgba(78,168,222,.1)",
            tension: .3, pointRadius: 0, borderWidth: 2, fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: dim } },
          tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + (c.dataset.yAxisID === "yCost" ? c.parsed.y + "¢" : c.parsed.y + " kWh") } },
        },
        scales: {
          x: { ticks: { color: dim, maxRotation: 0, autoSkip: true }, grid: { color: "rgba(128,128,128,.12)" } },
          yCost: { position: "left", title: { display: true, text: "¢ per half-hour", color: dim }, ticks: { color: dim, callback: (v) => v + "¢" }, grid: { color: "rgba(128,128,128,.12)" }, beginAtZero: true },
          yKwh: { position: "right", title: { display: true, text: "kWh", color: dim }, ticks: { color: dim }, grid: { drawOnChartArea: false }, beginAtZero: true },
        },
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Load-shifting optimiser                                             */
  /* ------------------------------------------------------------------ */

  const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function daysLabel(days) {
    if (!days || !days.length) return "every day";
    const set = [...days].sort();
    const weekdays = [1, 2, 3, 4, 5], weekend = [0, 6];
    const eq = (a, b) => a.length === b.length && a.every((v) => b.includes(v));
    if (eq(set, [0, 1, 2, 3, 4, 5, 6])) return "every day";
    if (eq(set, weekdays)) return "weekdays";
    if (eq(set, weekend)) return "weekends";
    return set.map((d) => DAY_ABBR[d]).join(", ");
  }
  function fmtTime(t) {
    const [h, m] = t.split(":").map(Number);
    const ap = h >= 12 ? "pm" : "am";
    let hr = h % 12; if (hr === 0) hr = 12;
    return m ? `${hr}:${String(m).padStart(2, "0")}${ap}` : `${hr}${ap}`;
  }

  // Analyse a plan's general-usage cost by rate tier and the saving available
  // from shifting higher-rate usage down to the plan's cheapest rate.
  function shiftPotential(plan) {
    const disc = 1 - num(plan.discount) / 100;
    const f = annualFactor();
    const byRate = new Map(); // rate -> kwh (period totals)
    for (const r of intervals) {
      if (r.kwh < 0 || r.register === "controlled") continue;
      const rate = rateForInterval(plan, r);
      byRate.set(rate, (byRate.get(rate) || 0) + r.kwh);
    }
    if (!byRate.size) return null;
    const rates = [...byRate.keys()];
    const targetRate = Math.min(...rates);

    let peakKwh = 0, maxSavingCents = 0;
    const tiers = [];
    for (const [rate, kwh] of byRate) {
      tiers.push({
        rate,
        kwhAnnual: kwh * f,
        costAnnual: (kwh * rate * disc / 100) * f,
        isTarget: rate === targetRate,
        label: tierLabel(plan, rate, targetRate),
      });
      if (rate > targetRate) {
        peakKwh += kwh;
        maxSavingCents += kwh * (rate - targetRate) * disc;
      }
    }
    tiers.sort((a, b) => b.rate - a.rate);

    const windowsAbove = (plan.windows || [])
      .filter((w) => num(w.rate) > targetRate)
      .map((w) => ({ label: w.label || "Peak", rate: num(w.rate), from: w.from, to: w.to, days: w.days }))
      .sort((a, b) => b.rate - a.rate);

    return {
      targetRate,
      peakKwhAnnual: peakKwh * f,
      maxSavingAnnual: (maxSavingCents / 100) * f,
      baselineAnnual: costForPlan(plan, intervals, usageStats).perYear,
      tiers,
      windowsAbove,
    };
  }

  function tierLabel(plan, rate, targetRate) {
    if (rate === targetRate) {
      const w = (plan.windows || []).find((x) => num(x.rate) === rate);
      return (w && w.label) ? w.label + " (cheapest)" : "Off-peak / default";
    }
    const w = (plan.windows || []).find((x) => num(x.rate) === rate);
    return (w && w.label) ? w.label : "Rate " + rate + "¢";
  }

  function renderOptimize() {
    const section = $("#step-optimize");
    // Candidates: plans where shifting actually helps (peak premium exists).
    const candidates = lastResults
      .map((r) => ({ plan: r.plan, pot: shiftPotential(r.plan) }))
      .filter((c) => c.pot && c.pot.maxSavingAnnual > 1);

    if (!candidates.length) { section.hidden = true; return; }
    section.hidden = false;

    const sel = $("#opt-plan");
    const ids = candidates.map((c) => c.plan.id);
    if (!ids.includes(optPlanId)) optPlanId = ids[0];
    sel.innerHTML = candidates
      .map((c) => `<option value="${c.plan.id}"${c.plan.id === optPlanId ? " selected" : ""}>${escapeHtml(c.plan.name || "Unnamed plan")}</option>`)
      .join("");

    renderOptDetail();
  }

  function renderOptDetail() {
    const plan = plans.find((p) => p.id === optPlanId);
    if (!plan) return;
    const pot = shiftPotential(plan);
    if (!pot) return;

    $("#opt-summary").className = "opt-summary";
    $("#opt-summary").innerHTML = [
      ["Current estimate", money(pot.baselineAnnual) + "/yr", ""],
      ["Peak / shoulder usage", fmt(pot.peakKwhAnnual, 0) + " kWh/yr", "above the cheapest rate"],
      ["Cheapest rate available", pot.targetRate + "¢/kWh", "your off-peak target"],
      ["Max possible saving", money(pot.maxSavingAnnual) + "/yr", "if all of it shifted", true],
    ].map(([lbl, n, sub, accent]) =>
      `<div class="stat"><div class="num${accent ? " accent" : ""}">${n}</div><div class="lbl">${lbl}</div><div class="lbl">${sub}</div></div>`
    ).join("");

    // Slider result
    const range = $("#opt-range");
    optPct = +range.value;
    $("#opt-pct").textContent = optPct;
    const saved = pot.maxSavingAnnual * (optPct / 100);
    const projected = pot.baselineAnnual - saved;
    $("#opt-result").innerHTML =
      `Shifting <strong>${optPct}%</strong> of your peak &amp; shoulder usage to off-peak could bring this plan to ` +
      `<span class="from">${money(pot.baselineAnnual)}</span> <span class="big">${money(projected)}/yr</span> ` +
      `— saving about <strong>${money(saved)}/yr</strong>.`;

    renderTierChart(pot);
    renderOptTips(pot, saved);
  }

  function renderTierChart(pot) {
    if (!hasChart()) return;
    if (tierChart) tierChart.destroy();
    const dim = getComputedStyle(document.body).getPropertyValue("--text-dim").trim() || "#888";
    tierChart = new Chart($("#tier-chart"), {
      type: "bar",
      data: {
        labels: pot.tiers.map((t) => `${t.label} (${t.rate}¢)`),
        datasets: [{
          label: "Annual cost",
          data: pot.tiers.map((t) => +t.costAnnual.toFixed(2)),
          backgroundColor: pot.tiers.map((t) => (t.isTarget ? "#52b788" : "#e07a5f")),
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true, indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => money(c.parsed.x) + "/yr  ·  " + fmt(pot.tiers[c.dataIndex].kwhAnnual, 0) + " kWh" } },
        },
        scales: {
          x: { ticks: { color: dim, callback: (v) => "$" + v }, grid: { color: "rgba(128,128,128,.12)" }, beginAtZero: true },
          y: { ticks: { color: dim }, grid: { display: false } },
        },
      },
    });
  }

  function renderOptTips(pot, saved) {
    const tips = [];
    if (pot.windowsAbove.length) {
      const list = pot.windowsAbove
        .map((w) => `<strong>${escapeHtml(w.label)}</strong> — ${daysLabel(w.days)} ${fmtTime(w.from)}–${fmtTime(w.to)} at ${w.rate}¢/kWh`)
        .join("</li><li>");
      tips.push(`Your expensive periods on this plan:<ul><li>${list}</li></ul>`);
    }
    tips.push(`Run high-draw appliances outside those windows — <strong>dishwasher, washing machine, clothes dryer, pool pump, and EV or battery charging</strong> are the easiest to reschedule. A timer or delay-start does most of the work.`);
    tips.push(`Every 1 kWh moved from a peak period to the ${pot.targetRate}¢ off-peak rate saves the gap between the two rates. Your realistic target is shifting flexible loads; fixed loads like lighting and cooking are harder to move.`);
    if (saved > 0) tips.push(`At the slider setting above, that's roughly <strong>${money(saved)}/year</strong> back in your pocket — before even switching plans.`);
    $("#opt-tips").innerHTML = "<h3>How to capture it</h3><ul><li>" + tips.join("</li><li>") + "</li></ul>";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  function savePlans() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(plans)); } catch (e) {}
  }
  function loadPlans() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        plans = JSON.parse(raw);
        planSeq = plans.reduce((m, p) => Math.max(m, p.id || 0), 0);
      }
    } catch (e) { plans = []; }
    if (!plans.length) {
      plans = [newPlan(false)];
      plans[0].name = "My current plan";
    }
  }

  /* ------------------------------------------------------------------ */
  /* Published-plan catalogue (from CDR data via GitHub Action)          */
  /* ------------------------------------------------------------------ */

  let catalog = null;

  function loadNmiNetworks() {
    fetch("data/nmi-networks.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.networks) { nmiNetworks = data.networks; if (detectedNmi && catalog) applyNmiDetection(); }
      })
      .catch(() => {});
  }

  // Identify the distribution network from an NMI using the AEMO allocation
  // patterns. The 11th char is a checksum, so we test the 10-char core too.
  function detectNetworkFromNmi(nmi) {
    if (!nmiNetworks || !nmi) return null;
    const candidates = [nmi.toUpperCase(), nmi.toUpperCase().slice(0, 10)];
    for (const net of nmiNetworks) {
      for (const pat of net.patterns) {
        let re;
        try { re = new RegExp("^(" + pat + ")$"); } catch (e) { continue; }
        if (candidates.some((c) => re.test(c))) return { name: net.name, region: net.region };
      }
    }
    return null;
  }

  // Map an AEMO network name to the distributor string used in the plan
  // catalogue (names differ, e.g. "SP AusNet" vs "AusNet Services").
  const NETWORK_ALIASES = {
    "ausnet": "ausnet", "evoenergy": "evoenergy", "actewagl": "evoenergy",
    "citipower": "citipower", "powercor": "powercor", "endeavour": "endeavour",
    "ergon": "ergon", "energex": "energex", "ausgrid": "ausgrid",
    "essential": "essential", "sa power": "sa power", "tasnetwork": "tasnetwork",
    "jemena": "jemena", "united": "united",
  };

  function catalogDistributorFor(networkName) {
    if (!networkName || !catalog) return null;
    const key = networkName.toLowerCase();
    let token = null;
    for (const k in NETWORK_ALIASES) if (key.includes(k)) { token = NETWORK_ALIASES[k]; break; }
    if (!token) return null;
    return (catalog.distributors || []).find((d) => d.toLowerCase().includes(token)) || null;
  }

  function loadCatalog() {
    fetch("data/plans.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.plans || !data.plans.length) return;
        catalog = data;
        buildCatalogPicker();
      })
      .catch(() => {});
  }

  function buildCatalogPicker() {
    const picker = $("#catalog-picker");
    picker.hidden = false;
    if (catalog.generatedAt) {
      const when = new Date(catalog.generatedAt).toLocaleDateString();
      $("#catalog-meta").textContent = `(${catalog.planCount} plans, updated ${when})`;
    }
    const dist = $("#catalog-dist");
    dist.innerHTML = `<option value="">All networks</option>` +
      (catalog.distributors || []).map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
    dist.addEventListener("change", () => { $("#catalog-nmi-note").hidden = true; refreshCatalogPlans(); });
    $("#catalog-search").addEventListener("input", refreshCatalogPlans);
    $("#catalog-postcode").addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4);
      refreshCatalogPlans();
    });
    $("#catalog-add").addEventListener("click", addCatalogPlan);
    refreshCatalogPlans();
    applyNmiDetection();
  }

  // After an upload, pre-select the catalogue distributor matching the NMI.
  function applyNmiDetection() {
    const noteEl = $("#catalog-nmi-note");
    if (!noteEl || !catalog) return;
    if (!detectedNmi) { noteEl.hidden = true; return; }
    detectedNetwork = detectNetworkFromNmi(detectedNmi);
    if (!detectedNetwork) { noteEl.hidden = true; return; }
    const dist = catalogDistributorFor(detectedNetwork.name);
    noteEl.hidden = false;
    if (dist) {
      $("#catalog-dist").value = dist;
      refreshCatalogPlans();
      noteEl.innerHTML = `Detected your network as <strong>${escapeHtml(detectedNetwork.name)}</strong> (${escapeHtml(detectedNetwork.region)}) from your NMI — filtered to <strong>${escapeHtml(dist)}</strong> plans. Change the dropdown if that's not right.`;
    } else {
      noteEl.innerHTML = `Detected your network as <strong>${escapeHtml(detectedNetwork.name)}</strong> (${escapeHtml(detectedNetwork.region)}) from your NMI.`;
    }
  }

  function catalogMatches() {
    const d = $("#catalog-dist").value;
    const q = $("#catalog-search").value.trim().toLowerCase();
    const pc = ($("#catalog-postcode").value || "").trim();
    const pcActive = /^\d{4}$/.test(pc) && catalog.postcodeSets;
    return catalog.plans.filter((p) => {
      if (d && !(p.distributors || []).includes(d)) return false;
      if (pcActive) {
        const set = p.pc != null ? catalog.postcodeSets[p.pc] : null;
        if (!set || !set.includes(pc)) return false;
      }
      if (q) {
        const hay = ((p.brand || "") + " " + (p.name || "") + " " + (p.retailer || "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function refreshCatalogPlans() {
    const matches = catalogMatches();
    $("#catalog-count").textContent = matches.length;
    const sel = $("#catalog-plan");
    sel.innerHTML = matches.slice(0, 400)
      .map((p) => {
        const idx = catalog.plans.indexOf(p);
        const label = (p.brand ? p.brand + " — " : "") + (p.name || "Plan") + (p.mode === "tou" ? " (TOU)" : "");
        return `<option value="${idx}">${escapeHtml(label)}</option>`;
      }).join("");
    if (matches.length > 400) sel.innerHTML += `<option disabled>…refine your search to see more</option>`;
  }

  function addCatalogPlan() {
    const idx = +$("#catalog-plan").value;
    const p = catalog.plans[idx];
    if (!p) return;
    plans.push({
      id: ++planSeq,
      name: (p.brand ? p.brand + " – " : "") + (p.name || "Plan"),
      supply: p.supply ?? "", controlled: p.controlled ?? "", feedin: p.feedin ?? "", discount: p.discount ?? "",
      mode: p.mode === "tou" ? "tou" : "flat",
      flat: p.flat ?? "", touDefault: p.touDefault ?? "",
      windows: (p.windows || []).map((w) => ({
        label: w.label || "", rate: w.rate ?? "",
        days: Array.isArray(w.days) ? w.days.slice() : [1, 2, 3, 4, 5],
        from: w.from || "00:00", to: w.to || "00:00",
      })),
    });
    renderPlans(); savePlans(); recompute();
    const cards = $$(".plan");
    if (cards.length) cards[cards.length - 1].scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function exportPlans() {
    const data = JSON.stringify({ app: "energy-compare-tool", version: 1, plans }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "energy-compare-plans.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importPlansFromText(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { alert("That file isn't valid JSON."); return; }
    const incoming = Array.isArray(parsed) ? parsed : parsed.plans;
    if (!Array.isArray(incoming) || !incoming.length) { alert("No plans found in that file."); return; }
    // Re-key ids so they stay unique in this session.
    plans = incoming.map((p) => ({
      id: ++planSeq,
      name: p.name || "Imported plan",
      supply: p.supply ?? "", controlled: p.controlled ?? "", feedin: p.feedin ?? "", discount: p.discount ?? "",
      mode: p.mode === "tou" ? "tou" : "flat",
      flat: p.flat ?? "", touDefault: p.touDefault ?? "",
      windows: Array.isArray(p.windows) ? p.windows.map((w) => ({
        label: w.label || "", rate: w.rate ?? "",
        days: Array.isArray(w.days) ? w.days.map(Number) : [1, 2, 3, 4, 5],
        from: w.from || "00:00", to: w.to || "00:00",
      })) : [],
    }));
    renderPlans(); savePlans(); recompute();
  }

  /* ------------------------------------------------------------------ */
  /* File handling                                                       */
  /* ------------------------------------------------------------------ */

  function handleText(text, sourceName) {
    const status = $("#parse-status");
    status.hidden = false;
    try {
      const { rows, skipped } = parseCsv(text);
      intervals = rows;
      usageStats = computeStats(rows);
      status.className = "status ok";
      status.textContent = `Loaded ${fmt(rows.length)} intervals from ${sourceName}` +
        (skipped ? ` (${skipped} rows skipped)` : "") + ". Scroll down for your usage breakdown.";
      renderUsage();
      renderPlans();
      recompute();
      applyNmiDetection();
      $("#step-usage").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      status.className = "status err";
      status.textContent = "Couldn't read that file: " + err.message;
    }
  }

  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => handleText(e.target.result, file.name);
    reader.onerror = () => {
      const status = $("#parse-status");
      status.hidden = false; status.className = "status err";
      status.textContent = "Failed to read the file.";
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------------ */
  /* Wire up                                                             */
  /* ------------------------------------------------------------------ */

  function init() {
    loadPlans();
    loadCatalog();
    loadNmiNetworks();

    const dz = $("#dropzone"), input = $("#file-input");
    $("#browse-btn").addEventListener("click", () => input.click());
    dz.addEventListener("click", (e) => { if (e.target === dz || e.target.classList.contains("dz-main")) input.click(); });
    input.addEventListener("change", () => handleFile(input.files[0]));

    ["dragenter", "dragover"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
    dz.addEventListener("drop", (e) => {
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    $("#load-sample").addEventListener("click", () => {
      const status = $("#parse-status");
      status.hidden = false; status.className = "status info"; status.textContent = "Loading sample data…";
      fetch("sample/sample-usage.csv")
        .then((r) => { if (!r.ok) throw new Error("sample not found"); return r.text(); })
        .then((t) => handleText(t, "sample data"))
        .catch(() => { status.className = "status err"; status.textContent = "Sample data couldn't be loaded."; });
    });

    $("#add-plan").addEventListener("click", () => addPlan(false));
    $("#add-plan-tou").addEventListener("click", () => addPlan(true));
    $("#clear-plans").addEventListener("click", () => {
      if (!confirm("Remove all plans?")) return;
      plans = [newPlan(false)];
      plans[0].name = "My current plan";
      renderPlans(); savePlans(); recompute();
    });

    $("#export-plans").addEventListener("click", exportPlans);
    $("#import-plans").addEventListener("click", () => $("#import-input").click());
    $("#import-input").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = (ev) => importPlansFromText(ev.target.result);
      reader.readAsText(f);
      e.target.value = "";
    });

    // Chart / optimiser selectors
    $("#profile-plan").addEventListener("change", (e) => {
      costProfilePlanId = +e.target.value; renderCostProfile();
    });
    $("#opt-plan").addEventListener("change", (e) => {
      optPlanId = +e.target.value; renderOptDetail();
    });
    $("#opt-range").addEventListener("input", renderOptDetail);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
