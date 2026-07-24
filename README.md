# Energy Compare Tool

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
- **The verdict** — every plan is costed against *your* usage, scaled to a full year, with a ranked table and comparison chart. Cheapest wins.
- **Rich comparison graphs:**
  - **Daily usage vs cost** — overlays how much you *spend* each half-hour (bars) against how much you *use* (line) on a selected plan, so you can see exactly when a plan hits hardest.
  - **Bill breakdown** — a stacked chart splitting each plan's annual cost into general usage, controlled load and supply charge (less solar credit).
  - **Cost by month** — tracks each plan across the months in your data to reveal seasonal swings.
- **Load-shifting advisor** — for time-of-use plans, works out how much of your usage lands in expensive peak/shoulder periods, groups your spend by rate tier, and lets you drag a slider to estimate savings from moving flexible load (dishwasher, washing, dryer, pool pump, EV charging) to off-peak — with tips that name your plan's actual peak windows.
- **Saved & portable plans** — plans are stored in your browser (`localStorage`) so they persist between visits, plus **Export/Import** to back them up as a JSON file or move them to another device.
- **Load real published plans** — pre-fill rates straight from the government's open plan data (see below), filter by your network/distributor, then tweak.
- **Automatic network detection** — your NMI (read from the uploaded file) is matched against the AEMO allocation table to identify your distribution network, and the plan picker is pre-filtered to plans valid in your area.
- **Postcode filter** — narrow the picker to plans actually available at your postcode (each plan carries its coverage area).

## Real plan data (Consumer Data Right)

Australian electricity retailers are required to publish their generally-available plans through the **Consumer Data Right (CDR)** energy Product Reference Data (PRD) APIs — public, unauthenticated, standardised JSON. This project pulls that data on a schedule so you can load real rates instead of typing them by hand.

How it works (fully static, no backend at runtime):

1. **`scripts/fetch-plans.mjs`** discovers retailer endpoints two ways — a curated seed list (`data/retailers.json`, for the majors) **plus dynamic discovery from the public [CDR Register](https://api.cdr.gov.au/cdr-register/v1/energy/data-holders/brands/summary)** — pre-probes them all in parallel, then calls each live retailer's `GET /cds-au/v1/energy/plans` and `…/plans/{id}` endpoints and **normalises** the tariffs into this app's model. CDR prices are in *dollars*; the normaliser converts everything to cents, maps time-of-use windows (peak/shoulder/off-peak, days, times), and pulls in controlled-load and solar feed-in rates. Plans are de-duplicated by plan ID.
2. **`.github/workflows/update-plans.yml`** runs the script on a daily cron (and on demand from the Actions tab), then commits the refreshed **`data/plans.json`** back to the repo.
3. The front-end loads `data/plans.json` and shows the **"Load a published plan"** picker in step 3. Your usage data still never leaves the browser.

The committed `data/plans.json` currently holds ~930 real residential plans from ~26 retailers (AGL, Origin, EnergyAustralia, ENGIE, OVO, Amber, Powershop, Momentum, GloBird, Flow Power, Kogan, Lumo, Nectr, Tango, Dodo, Ergon, ActewAGL and more) across all 15 distribution networks (Ausgrid, Endeavour, Essential, Energex, Ergon, SA Power Networks, Citipower, Powercor, United Energy, AusNet, Jemena, Evoenergy, TasNetworks…).

Notes & limitations:

- **Endpoint discovery** merges three sources, de-duplicated and pre-probed: the curated `data/retailers.json` seed, a [community-maintained endpoint list](https://github.com/jxeeno/energy-cdr-prd-endpoints) that exposes each brand's `productReferenceDataBaseUri`, and the official [CDR Register](https://api.cdr.gov.au/cdr-register/v1/energy/data-holders/brands/summary) as a fallback. Between them these reach the large majority of retailers including ones that were previously hard to find (Red Energy, Alinta, Sumo, Aurora, Diamond…).

### Network detection (NMI → distributor)

`data/nmi-networks.json` holds the AEMO NMI allocation patterns for the 13 distribution networks. On upload, the app reads the NMI from your file, matches it (the 11th digit is a checksum, so the 10-char core is tested too), identifies your distributor, and pre-filters the plan picker. Regenerate it from the upstream [`aemo` gem allocation table](https://github.com/jufemaiz/aemo) if allocations change.

### Postcode coverage

Each plan lists the postcodes it's available in. Since plans share a small number of distinct coverage areas (~23 across the whole catalogue), the sets are de-duplicated: `data/plans.json` stores each unique set once in `postcodeSets` and every plan references it by index (`pc`). This keeps the file ~700 KB instead of several megabytes. The fetcher samples plans per retailer **and per network** (`MAX_PER_NETWORK`) so every distribution area a retailer serves is represented.
- **HTTP client:** the government CDR endpoints sit behind a WAF that rejects Node's native `fetch` TLS fingerprint (403) but accepts `curl`, so the fetch script shells out to `curl` (present on GitHub runners).
- The `MAX_PER_RETAILER` cap samples each retailer so the catalogue spans many brands/networks rather than exhausting one; raise it (and `MAX_PLANS`) for fuller coverage.
- Covers National Energy Customer Framework states (NSW, QLD, SA, TAS, ACT). Victoria runs a separate scheme.
- These are list/market rates for residential electricity — not personalised or negotiated discounts. Off-peak is chosen by the `OFF_PEAK` tariff type (so free/solar-sponge windows stay as windows, not the all-day default). Demand-charge and complex block tariffs aren't fully modelled and are skipped or simplified.
- Run it locally with `node scripts/fetch-plans.mjs`; unit tests for the normaliser: `node scripts/test-normalize.mjs`.

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
