#!/usr/bin/env node
/** Offline unit tests for the PRD normaliser (no network). */
import { normalizePlanDetail, toCents } from "./fetch-plans.mjs";
import assert from "node:assert";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ok:", name); pass++; };

// toCents: dollars -> cents
ok("toCents dollars->cents", toCents("0.24500") === 24.5);
ok("toCents supply", toCents("0.98000") === 98);
ok("toCents blank", toCents("") === null);

// Flat single-rate plan with controlled load and solar
const flatDetail = {
  planId: "PLAN-FLAT", displayName: "Simple Saver", brandName: "TestCo",
  fuelType: "ELECTRICITY", customerType: "RESIDENTIAL",
  geography: { distributors: ["Ausgrid"] },
  electricityContract: {
    pricingModel: "SINGLE_RATE_CONT_LOAD",
    tariffPeriod: [{
      dailySupplyChargeType: "SINGLE", dailySupplyCharge: "1.10000",
      rateBlockUType: "singleRate",
      singleRate: { rates: [{ unitPrice: "0.28000", measureUnit: "KWH" }] },
    }],
    controlledLoad: [{ rateBlockUType: "singleRate", singleRate: { rates: [{ unitPrice: "0.18000" }] } }],
    solarFeedInTariff: [{ payerType: "RETAILER", tariffUType: "singleTariff", singleTariff: { rates: [{ unitPrice: "0.05000" }] } }],
  },
};
const flat = normalizePlanDetail(flatDetail);
ok("flat mode", flat.mode === "flat");
ok("flat rate 28c", flat.flat === 28);
ok("flat supply 110c", flat.supply === 110);
ok("flat controlled 18c", flat.controlled === 18);
ok("flat feedin 5c", flat.feedin === 5);
ok("flat distributor", flat.distributors[0] === "Ausgrid");

// Time-of-use plan: peak / shoulder / off-peak
const touDetail = {
  planId: "PLAN-TOU", displayName: "Flex TOU", brandName: "TestCo",
  fuelType: "ELECTRICITY", customerType: "RESIDENTIAL",
  geography: { distributors: ["Energex"] },
  electricityContract: {
    pricingModel: "TIME_OF_USE",
    tariffPeriod: [{
      dailySupplyCharge: "0.95000",
      rateBlockUType: "timeOfUseRates",
      timeOfUseRates: [
        { type: "PEAK", rates: [{ unitPrice: "0.55000" }], timeOfUse: [{ days: ["MON", "TUE", "WED", "THU", "FRI"], startTime: "15:00:00", endTime: "21:00:00" }] },
        { type: "SHOULDER", rates: [{ unitPrice: "0.30000" }], timeOfUse: [{ days: ["MON", "TUE", "WED", "THU", "FRI"], startTime: "0700", endTime: "1500" }] },
        { type: "OFF_PEAK", rates: [{ unitPrice: "0.20000" }], timeOfUse: [{ days: ["SAT", "SUN"], startTime: "00:00:00", endTime: "24:00:00" }] },
      ],
    }],
  },
};
const tou = normalizePlanDetail(touDetail);
ok("tou mode", tou.mode === "tou");
ok("tou default = offpeak 20c", tou.touDefault === 20);
ok("tou two windows (peak+shoulder)", tou.windows.length === 2);
const peak = tou.windows.find((w) => w.label === "Peak");
ok("peak rate 55c", peak.rate === 55);
ok("peak days mapped Mon-Fri", JSON.stringify(peak.days) === JSON.stringify([1, 2, 3, 4, 5]));
ok("peak from 15:00", peak.from === "15:00");
ok("peak to 21:00", peak.to === "21:00");
const shoulder = tou.windows.find((w) => w.label === "Shoulder");
ok("shoulder HHMM parsed", shoulder.from === "07:00" && shoulder.to === "15:00");

// Demand-only tariff is skipped
const demand = normalizePlanDetail({
  electricityContract: { tariffPeriod: [{ rateBlockUType: "demandCharges", demandCharges: [{ amount: "0.10" }] }] },
});
ok("demand-only skipped", demand === null);

// Gas-only skipped
ok("no electricity contract skipped", normalizePlanDetail({ gasContract: {} }) === null);

console.log(`\nAll ${pass} assertions passed.`);
