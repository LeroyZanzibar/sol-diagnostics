import { arrayCapacityModel, type CapacityAsset } from "../../array-capacity";

type Inverter = { id: string; acKw: number; dcKw: number; referenceYieldLimit: number };
type CurvePoint = { rate: number; kw: number; slope: number };
type Point = { timestamp: string; energyKwh: number };
export const INVERTER_EXPECTATION_METHOD = {
  version: 1, minimumDeficitPercent: 10, minimumDays: 3, minimumDeficitHours: 3,
  minimumIrradianceWm2: 200, minimumExpectedAcFraction: .1, maximumLoadingFraction: .95,
  basis: "Primary inverter baseline derived from site Expected Production at the meter / POI, with no shading allowance. Undo configured delivery losses and solve a common output per kWdc with individual inverter AC and transformer branch ceilings. Measured inverter output is not used to fit the baseline.",
  persistence: "At least a 10% deficit on three local dates totaling three hours; days and intervals need not be consecutive. Existing outage and onsite-snow rules remain separate.",
  peers: "Optional corroboration only. Missing peers never suppress primary detection. Corroborated shared fleet reductions are subsequently consolidated at site level, with additional inverter deficits retained.",
  exclusions: "Underperformance detection excludes irradiance below 200 W/m², expected output below 10% of inverter AC rating, telemetry blocks, and expected or measured output at or above 95% of inverter or transformer capacity. Snow is handled by the existing onsite-snow rule. Missing, invalid, capacity-inconsistent expected data or an incomplete model uses the historical detector, identified as a fallback.",
  limitation: "Derived allocation assumes comparable array response; orientation, tilt, tracking and inverter-specific efficiency are not yet modeled. Agreement is not independent validation of health, and a deficit does not establish its cause.",
  lossBasis: "Inverter-terminal expected minus actual energy, constrained by recoverable transformer headroom, converted to delivered energy using configured losses and reconciled once with meter findings. Peer evidence never adds a second loss.",
};

// Piecewise-linear output curves are built once per model, not once per reading.
function outputCurve(initialSlope: number, events: Map<number, number>): CurvePoint[] {
  const points = [{ rate: 0, kw: 0, slope: initialSlope }];
  for (const [rate, drop] of [...events].sort(([a], [b]) => a - b)) {
    const last = points.at(-1)!;
    points.push({ rate, kw: last.kw + (rate - last.rate) * last.slope, slope: Math.max(0, last.slope - drop) });
  }
  return points;
}
function rateAt(curve: CurvePoint[], kw: number) {
  if (kw <= 0) return 0;
  const end = curve.at(-1)!;
  if (kw > end.kw + Math.max(1e-8, end.kw * 1e-9)) return Infinity;
  let low = 1, high = curve.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (curve[middle].kw < kw) low = middle + 1; else high = middle;
  }
  const previous = curve[low - 1];
  return previous?.slope > 0 ? previous.rate + (Math.min(kw, end.kw) - previous.kw) / previous.slope : 0;
}

/** An allocation of unshaded POI expectation, not an independently validated inverter model. */
export function inverterExpectationModel(assets: CapacityAsset[]) {
  const capacity = arrayCapacityModel(assets), issues = [...capacity.issues];
  const meters = assets.filter(a => a.type === "revenue_meter");
  if (meters.length !== 1) issues.push("A single meter / POI is required to allocate site expected production.");
  for (const value of [meters[0]?.acLineLossPercent, meters[0]?.transformerLossPercent]) {
    if (value != null && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) >= 100))
      issues.push("Configured delivery losses must be between zero and less than 100 percent.");
  }
  const inverters = new Map<string, Inverter>();
  const modules = new Map<string, CapacityAsset[]>();
  for (const a of assets) if (a.type === "module_group" && a.parentId) {
    const parts = modules.get(a.parentId) || []; parts.push(a); modules.set(a.parentId, parts);
  }
  for (const a of assets.filter(a => a.type === "inverter")) {
    const parts = modules.get(a.id) || [], acKw = Number(a.acRatedCapacityKw);
    if (!Number.isFinite(acKw) || acKw <= 0 || !parts.length || parts.some(p =>
      !Number.isFinite(Number(p.moduleRatedCapacityW)) || Number(p.moduleRatedCapacityW) <= 0 ||
      !Number.isInteger(p.quantity) || Number(p.quantity) <= 0)) {
      issues.push(`${a.name || a.id}: complete the AC rating and all connected module DC ratings.`); continue;
    }
    const dcKw = parts.reduce((sum, p) => sum + Number(p.moduleRatedCapacityW) * Number(p.quantity) / 1000, 0);
    if (!Number.isFinite(dcKw) || dcKw <= 0) { issues.push(`${a.name || a.id}: invalid connected DC capacity.`); continue; }
    inverters.set(a.id, { id: a.id, acKw, dcKw, referenceYieldLimit: .95 * acKw / dcKw });
  }
  if (!inverters.size) issues.push("Configured inverter capacities are required.");
  const fleetEvents = new Map<number, number>();
  const addEvent = (rate: number, drop: number) => fleetEvents.set(rate, (fleetEvents.get(rate) || 0) + drop);
  const branches = capacity.hasTransformers ? capacity.branches.map(b => ({ ids: b.inverterIds, limit: b.limitKw }))
    : [{ ids: [...inverters.keys()], limit: Infinity }];
  let fleetSlope = 0;
  for (const branch of branches) {
    const members = branch.ids.flatMap(id => inverters.has(id) ? [inverters.get(id)!] : []);
    if (!members.length) continue;
    const slope = members.reduce((sum, i) => sum + i.dcKw, 0), events = new Map<number, number>();
    for (const i of members) { const r = i.acKw / i.dcKw; events.set(r, (events.get(r) || 0) + i.dcKw); }
    const curve = outputCurve(slope, events), saturation = rateAt(curve, branch.limit);
    const nearSaturation = rateAt(curve, branch.limit * .95);
    fleetSlope += slope;
    let remainingSlope = slope;
    for (const [rate, drop] of [...events].sort(([a], [b]) => a - b)) {
      if (rate >= saturation) break;
      addEvent(rate, drop); remainingSlope -= drop;
    }
    if (Number.isFinite(saturation)) addEvent(saturation, remainingSlope);
    for (const i of members) i.referenceYieldLimit = Math.min(i.referenceYieldLimit, nearSaturation);
  }
  const curve = outputCurve(fleetSlope, fleetEvents);
  const ready = issues.length === 0 && capacity.deliveryFactor > 0;
  return {
    ready, issues, inverters, deliveryFactor: capacity.deliveryFactor, gridExportCeilingKw: capacity.gridExportKw,
    solve(siteEnergyKwh: number | undefined, hours: number): { status: "available" | "missing" | "invalid" | "capacityConflict" | "modelIncomplete"; rate: number } {
      if (!ready) return { status: "modelIncomplete", rate: 0 };
      if (siteEnergyKwh === undefined) return { status: "missing", rate: 0 };
      if (!Number.isFinite(siteEnergyKwh) || siteEnergyKwh < 0 || !Number.isFinite(hours) || hours <= 0) return { status: "invalid", rate: 0 };
      const ceiling = capacity.gridExportKw || 0;
      if (siteEnergyKwh / hours > ceiling + Math.max(1e-6, ceiling * 1e-9)) return { status: "capacityConflict", rate: 0 };
      const rate = rateAt(curve, siteEnergyKwh / hours / capacity.deliveryFactor);
      return Number.isFinite(rate) ? { status: "available", rate } : { status: "capacityConflict", rate: 0 };
    },
  };
}

/** Store one solved site value per timestamp; never materialize an inverter × year matrix. */
export function inverterExpectationContext(summary: { intervalMinutes?: number; expectedProduction?: Point[]; intervalIrradiance?: { timestamp: string; averageWm2: number }[] }, assets: CapacityAsset[], sourceExpected = summary.expectedProduction || []) {
  const model = inverterExpectationModel(assets), hours = (summary.intervalMinutes || 60) / 60;
  const rates = new Map<string, ReturnType<typeof model.solve>>();
  let cursor = 0;
  // Only the existing daylight detector uses these values. Walk sorted source
  // readings instead of retaining another full-year expected-production map.
  for (const sun of [...(summary.intervalIrradiance || [])].sort((a,b)=>a.timestamp.localeCompare(b.timestamp))) {
    if (sun.averageWm2 < 50) continue;
    while (cursor < sourceExpected.length && sourceExpected[cursor].timestamp < sun.timestamp) cursor++;
    const point = sourceExpected[cursor];
    rates.set(sun.timestamp, model.solve(point?.timestamp === sun.timestamp ? point.energyKwh : undefined, hours));
  }
  const expectedData = { available: 0, missing: 0, invalid: 0, capacityConflict: 0, modelIncomplete: 0 };
  for (const p of summary.intervalIrradiance || []) if (p.averageWm2 >= INVERTER_EXPECTATION_METHOD.minimumIrradianceWm2)
    expectedData[(rates.get(p.timestamp) || model.solve(undefined, hours)).status]++;
  const coverage = { comparedInverterIntervals: 0, fallbackInverterIntervals: 0, capacityLimitedInverterIntervals: 0,
    telemetryBlockedInverterIntervals: 0, lowLightInverterIntervals: 0, snowInverterIntervals: 0, invertersWithRepeatedDeficits: 0 };
  return { model, hours, rates, expectedData, coverage,
    at(id: string, timestamp: string) {
      const i = model.inverters.get(id), result = rates.get(timestamp);
      if (!i || result?.status !== "available") return undefined;
      return { expectedKwh: Math.min(i.acKw, i.dcKw * result.rate) * hours,
        capacityLimited: result.rate >= i.referenceYieldLimit - 1e-9 };
    },
    methodology() {
      const status = !coverage.comparedInverterIntervals ? "unavailable" : coverage.fallbackInverterIntervals || expectedData.capacityConflict || expectedData.invalid || expectedData.missing ? "limited" : "available";
      const message = (status === "unavailable" ? "No eligible model-derived inverter comparisons were available. Review expected data, array configuration and exclusions; historical and outage checks remain active."
        : "Inverters are compared directly with expectations derived from site Expected Production. Peer references are optional." + (status === "limited" ? " Some intervals used the historical fallback because a usable derived expectation was unavailable." : "")) +
        (expectedData.capacityConflict ? ` ${expectedData.capacityConflict} daylight expected-production intervals exceed the configured export ceiling and cannot supply an inverter baseline.` : "");
      return { ...INVERTER_EXPECTATION_METHOD, status, message, modelIssues: model.issues, deliveryFactor: model.deliveryFactor,
        gridExportCeilingKw: model.gridExportCeilingKw, expectedData, coverage };
    },
  };
}
export type InverterExpectationContext = ReturnType<typeof inverterExpectationContext>;
