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
  let planSeq = 0;

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

    if (iStart === -1) throw new Error("Couldn't find a start-date/time column. Expected a column like 'StartDate'.");
    const iValue = iProfile !== -1 ? iProfile : iRegisterRead;
    if (iValue === -1) throw new Error("Couldn't find a usage value column (e.g. 'ProfileReadValue').");

    const rows = [];
    let skipped = 0;
    for (let i = 1; i < lines.length; i++) {
      const c = splitCsvLine(lines[i]);
      if (c.length <= iValue) { skipped++; continue; }
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
      $("#verdict").className = "verdict none";
      $("#verdict").innerHTML = "<p>Enter rates for at least one plan above to see the comparison.</p>";
      $("#results-table-wrap").innerHTML = "";
      if (compareChart) { compareChart.destroy(); compareChart = null; }
      return;
    }

    const results = usable.map((p) => ({ plan: p, cost: costForPlan(p, intervals, usageStats) }));
    results.sort((a, b) => a.cost.perYear - b.cost.perYear);
    const cheapest = results[0], dearest = results[results.length - 1];

    resultsSection.hidden = false;
    const v = $("#verdict");
    v.className = "verdict";
    if (results.length === 1) {
      v.innerHTML = `<h3>${escapeHtml(cheapest.plan.name)}</h3><p>Estimated <span class="save">${money(cheapest.cost.perYear)}/year</span> (${money(cheapest.cost.perDay)}/day) for your usage. Add another plan to compare.</p>`;
    } else {
      const saving = dearest.cost.perYear - cheapest.cost.perYear;
      v.innerHTML = `<h3>🏆 ${escapeHtml(cheapest.plan.name)} is cheapest</h3>
        <p>Estimated <span class="save">${money(cheapest.cost.perYear)}/year</span> — that's <span class="save">${money(saving)}/year cheaper</span> than the most expensive option (${escapeHtml(dearest.plan.name)}).</p>`;
    }

    renderResultsTable(results, cheapest);
    renderCompareChart(results, cheapest);
  }

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
  }

  document.addEventListener("DOMContentLoaded", init);
})();
