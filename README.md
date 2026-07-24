# ⚡ Energy Compare Tool

A static, browser-only web app that helps you find the **cheapest electricity plan for your actual usage**. Upload your smart-meter interval export, enter the details of one or more plans (flat or time-of-use), and it plots your usage and ranks the plans by estimated annual cost.

**Your data never leaves your browser.** Parsing and all calculations run client-side — nothing is uploaded to any server. That makes it safe to host on GitHub Pages.

## Features

- **Upload interval data** — drag & drop a CSV. Built for Australian NMI interval exports (the ones with `Generalusage` + `Controlledload` registers and `ProfileReadValue`), but it auto-detects common column names so other half-hourly/hourly exports work too.
- **Usage insights** — total & average consumption, an average daily **load profile**, and a **day × hour heatmap** so you can see when you use power.
- **Plan builder** — add your current plan and any competitors:
  - Flat rate **or** time-of-use (peak / shoulder / off-peak) with fully configurable time windows and days of the week
  - Daily supply charge
  - Separate controlled-load rate (e.g. hot water)
  - Solar feed-in credit (for exported energy)
  - Pay-on-time / membership % discount
- **The verdict** — every plan is costed against *your* usage, scaled to a full year, with a ranked table and comparison chart. Cheapest wins. 🏆
- Plans are saved in your browser (`localStorage`) so they're still there next time.

## How costs are calculated

For each half-hour interval in your data:

1. The applicable **rate** is chosen — controlled-load rate for controlled-load reads; otherwise the flat rate, or the first matching time-of-use window (falling back to the plan's default/off-peak rate).
2. `interval kWh × rate` is added to the running usage cost.
3. A usage **discount** is applied, the **daily supply charge** is added for each day of data, and any **solar feed-in** credit is subtracted.

The total is then scaled from the number of days in your file to `365` for an annual estimate.

> These are estimates for comparison only. Real bills vary with GST, rounding, seasonal usage, demand charges, connection fees and specific plan terms. Always check the full plan details.

## Running locally

It's a plain static site — no build step. Just serve the folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` directly via `file://` mostly works, but the **Try sample data** button needs `fetch`, so use a local server for that.)

## Deploying to GitHub Pages

Two options:

- **Settings → Pages → Deploy from a branch** → pick your branch and `/ (root)`, or
- Use the included workflow at `.github/workflows/pages.yml`, which publishes automatically on push to the default branch (**Settings → Pages → Source → GitHub Actions**).

## Project structure

```
index.html              # markup & templates
css/styles.css          # styling (light + dark aware)
js/app.js               # CSV parsing, stats, cost engine, charts
sample/sample-usage.csv # synthetic example data
```

Charts use [Chart.js](https://www.chartjs.org/) via CDN; everything else is vanilla JS with no dependencies.
