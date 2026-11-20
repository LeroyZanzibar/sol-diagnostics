import { arrayCapacityModel, type CapacityAsset } from "../../array-capacity";

type Inverter = { id: string; acKw: number; dcKw: number; referenceYieldLimit: number };
type CurvePoint = { rate: number; kw: number; slope: number };
type Point = { timestamp: string; energyKwh: number };
export const INVERTER_EXPECTATION_METHOD = {
  version: 2,
  basis: "Allocate the supplied site Expected Production across the complete configured module DC/inverter AC population and independent transformer branches, without fitting measured output.",
  lossBasis: "Constrain inverter-terminal loss to recoverable branch headroom and convert once to delivered meter / POI energy.",
  unavailable: "Missing, invalid or capacity-inconsistent expectation, incomplete configuration, or missing branch actual coverage leaves outage loss unknown; there is no fallback.",
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
  if (!capacity.hasTransformers && assets.some(a => a.type === "inverter" && a.parentId !== meters[0]?.id))
    issues.push("Connect every inverter to the configured meter / POI.");
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
  const expected = new Map(sourceExpected.map(p => [p.timestamp, p.energyKwh]));
  const sunlight = new Map((summary.intervalIrradiance || []).map(p => [p.timestamp, p.averageWm2]));
  const expectedData = { available: 0, missing: 0, invalid: 0, capacityConflict: 0, modelIncomplete: 0 };
  for (const timestamp of new Set([...expected.keys(), ...sunlight.keys()])) {
    const sun = sunlight.get(timestamp), value = expected.get(timestamp);
    if (!(sun !== undefined ? Number.isFinite(sun) && sun >= 50 : value !== undefined && Number.isFinite(value) && value > 0)) continue;
    const result = model.solve(value, hours);
    rates.set(timestamp, result); expectedData[result.status]++;
  }
  return { model, hours, rates, expectedData,
    at(id: string, timestamp: string) {
      const i = model.inverters.get(id), result = rates.get(timestamp);
      if (!i || result?.status !== "available") return undefined;
      return { expectedKwh: Math.min(i.acKw, i.dcKw * result.rate) * hours,
        capacityLimited: result.rate >= i.referenceYieldLimit - 1e-9 };
    },
    methodology() {
      return { ...INVERTER_EXPECTATION_METHOD, modelIssues: model.issues, deliveryFactor: model.deliveryFactor,
        gridExportCeilingKw: model.gridExportCeilingKw, expectedData };
    },
  };
}
export type InverterExpectationContext = ReturnType<typeof inverterExpectationContext>;
