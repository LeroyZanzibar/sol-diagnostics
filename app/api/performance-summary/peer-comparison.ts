import { localTimestamp } from "../../telemetry-time";
import { type CapacityAsset } from "../../array-capacity";
import { inverterExpectationContext } from "./inverter-expectation";

type Asset = CapacityAsset;
type Point = { timestamp: string; energyKwh: number };
type Summary = { timezone?: string; intervalMinutes?: number; snowSensorConfigured?: boolean; snowDays?: string[];
  causeContext?: { timeZone: string }; intervalIrradiance?: { timestamp: string; averageWm2: number }[];
  expectedProduction?: Point[]; equipmentProduction?: { equipmentId: string; equipmentType: string; intervalProduction?: Point[] }[] };
export type PeerGroup = { key: string; acKw: number; dcKw: number; ids: string[] };
export type PeerInterval = { expectedKwh: number; modelExpectedKwh: number; actualToPeerRatio: number; peerSetIndex: number; peerCount: number };
export type PeerFinding = { group: PeerGroup; intervals: Map<string, PeerInterval>; qualifiedDays: number; deficitHours: number };
export const PEER_METHOD = { version: 2, matching: "Equal configured AC rating and summed module DC rating; numerical rounding only (0.001 W).",
  role: "Optional supporting evidence for the primary model-derived inverter detector; never a prerequisite and never an additional loss estimate.",
  minimumPeers: 2, minimumDeficitPercent: 10, minimumDays: 3, minimumDeficitHours: 3,
  minimumIrradianceWm2: 200, maximumPeerOutputFraction: 0.95, maximumPeerDeviationFraction: 0.1,
  qualification: { maximumModelDeviationFraction: 0.1, minimumAgreementFraction: 0.8, minimumDays: 3, minimumHours: 3,
    window: "Local calendar month and hour; retrospective qualification within the analyzed data.",
    basis: "Site Expected Production at the meter / POI, with no shading allowance. Undo configured delivery losses and solve a common output per kWdc with each inverter AC ceiling and transformer branch ceiling. No observed inverter output is used to fit this expectation.",
    exclusions: "Missing or invalid expected data, incomplete model, expected energy above the configured export ceiling, snow, telemetry blocks, expected or measured capacity limiting, and expected output below 10% of inverter AC rating.",
    interpretation: "Qualified against a derived expectation; this is not independent validation of inverter health." },
  reference: "At least two model-qualified matching peers, also within 10% of the derived expectation at this interval and agreeing within 10% of their median; target excluded.",
  deferredFactors: "Orientation, tilt, tracking, and other configuration factors are not yet matched.",
  limitation: "Shared underperformance cannot qualify its own references. With fewer than two qualified references, peer corroboration is unavailable; primary model-derived detection continues. The derived allocation assumes comparable array behavior and cannot establish a physical cause." };

type WindowStats = { eligibleIntervals: number; matchedIntervals: number; days: Set<string> };
type QualificationRecord = { equipmentId: string; qualified: boolean; windows: { window: string; eligibleIntervals: number; matchedIntervals: number; matchedDays: number; matchedHours: number; agreementFraction: number; qualified: boolean }[];
  excluded: { capacityLimited: number; telemetryBlocked: number; lowExpectedOutput: number; missingOrInvalidReading: number; outsideModelBand: number } };
export type ReferenceQualification = { status: "available" | "limited" | "unavailable"; message: string; modelIssues: string[];
  deliveryFactor: number; gridExportCeilingKw: number | null; qualifiedInverters: number; comparedInverterIntervals: number;
  insufficientReferenceIntervals: number; expectedData: Record<string, number>; records: QualificationRecord[] };
export type PeerPlan = { groups: Map<string, PeerGroup>; findings: Map<string, PeerFinding>; recoveryDays: Map<string, Set<string>>; referenceSets: string[][]; referenceQualification: ReferenceQualification };

export function capacityPeerGroups(assets: Asset[]) {
  const modules = new Map<string, Asset[]>();
  for (const asset of assets) if (asset.type === "module_group" && asset.parentId) {
    const items = modules.get(asset.parentId) || []; items.push(asset); modules.set(asset.parentId, items);
  }
  const byKey = new Map<string, PeerGroup>(), groups = new Map<string, PeerGroup>();
  for (const asset of assets) {
    if (asset.type !== "inverter") continue;
    const acKw = Number(asset.acRatedCapacityKw), parts = modules.get(asset.id) || [];
    // Missing/invalid nameplate values must never become an inferred peer group.
    if (!Number.isFinite(acKw) || acKw <= 0 || !parts.length || parts.some(p =>
      !Number.isFinite(Number(p.moduleRatedCapacityW)) || Number(p.moduleRatedCapacityW) <= 0 ||
      !Number.isInteger(p.quantity) || Number(p.quantity) <= 0)) continue;
    const dcKw = parts.reduce((sum, p) => sum + Number(p.moduleRatedCapacityW) * Number(p.quantity) / 1000, 0);
    if (!Number.isFinite(dcKw) || dcKw <= 0) continue;
    const key = `${Math.round(acKw * 1e6)}:${Math.round(dcKw * 1e6)}`;
    const group = byKey.get(key) || { key, acKw, dcKw, ids: [] };
    group.ids.push(asset.id); byKey.set(key, group); groups.set(asset.id, group);
  }
  return groups;
}
const mid = (sorted: number[]) => sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
const wallTime = (t: string, zone: string) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(t) ? localTimestamp(t, zone) : t;

export function compareCapacityPeers(summary: Summary, assets: Asset[], blocked = new Map<string, Set<string>>(), sourceExpected = summary.expectedProduction || [], context = inverterExpectationContext(summary, assets, sourceExpected)): PeerPlan {
  const groups = capacityPeerGroups(assets), findings = new Map<string, PeerFinding>(), recoveryDays = new Map<string, Set<string>>();
  const referenceSets: string[][] = [], referenceIndexes = new Map<string, number>();
  const hours = (summary.intervalMinutes || 60) / 60, zone = summary.timezone || summary.causeContext?.timeZone || "UTC";
  const model = context.model;
  const expectedData: Record<string, number> = { available: 0, missing: 0, invalid: 0, capacityConflict: 0, modelIncomplete: 0 };
  const snow = new Set(summary.snowSensorConfigured ? summary.snowDays || [] : []);
  const daylight = (summary.intervalIrradiance || []).filter(p => p.averageWm2 >= PEER_METHOD.minimumIrradianceWm2)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map(p => {
      const local = wallTime(p.timestamp, zone), day = local.slice(0, 10);
      return { timestamp: p.timestamp, day, window: `${local.slice(0, 7)} ${local.slice(11, 13)}` };
    }).filter(p => !snow.has(p.day)).map(p => {
      const result = context.rates.get(p.timestamp) || model.solve(undefined, hours); expectedData[result.status]++;
      return { ...p, ...result };
    });
  const series = new Map((summary.equipmentProduction || []).map(p => [p.equipmentId, p.intervalProduction || []]));
  const records: QualificationRecord[] = [];
  let comparedInverterIntervals = 0, insufficientReferenceIntervals = 0;
  for (const group of new Set(groups.values())) {
    // Walk existing sorted series with cursors: do not duplicate a year of readings in maps.
    const members = group.ids.map(id => ({ id, points: series.get(id) || [], index: 0,
      windows: new Map<string, WindowStats>(), qualifiedWindows: new Set<string>(),
      excluded: { capacityLimited: 0, telemetryBlocked: 0, lowExpectedOutput: 0, missingOrInvalidReading: 0, outsideModelBand: 0 } }));
    const sample = (member: typeof members[number], sun: typeof daylight[number]) => {
      while (member.index < member.points.length && member.points[member.index].timestamp < sun.timestamp) member.index++;
      const p = member.points[member.index];
      return p?.timestamp === sun.timestamp ? p.energyKwh : undefined;
    };
    const matches = (value: number | undefined, expectedKwh: number) => value !== undefined && Number.isFinite(value) && value > 0 &&
      value / expectedKwh > 1 - PEER_METHOD.minimumDeficitPercent / 100 + 1e-9 &&
      Math.abs(value / expectedKwh - 1) <= PEER_METHOD.qualification.maximumModelDeviationFraction + 1e-9;
    // Qualification uses external expectation only. Agreement with a degraded fleet cannot pass this test.
    for (const sun of daylight) {
      if (sun.status !== "available") continue;
      const modelExpectedKwh = Math.min(group.acKw, group.dcKw * sun.rate) * hours;
      for (const member of members) {
        const value = sample(member, sun);
        if (blocked.get(member.id)?.has(sun.timestamp)) { member.excluded.telemetryBlocked++; continue; }
        if (sun.rate >= (model.inverters.get(member.id)?.referenceYieldLimit ?? 0) - 1e-9 ||
          (value !== undefined && value >= group.acKw * hours * PEER_METHOD.maximumPeerOutputFraction)) { member.excluded.capacityLimited++; continue; }
        if (modelExpectedKwh < group.acKw * hours * .1) { member.excluded.lowExpectedOutput++; continue; }
        const stats = member.windows.get(sun.window) || { eligibleIntervals: 0, matchedIntervals: 0, days: new Set<string>() };
        stats.eligibleIntervals++;
        if (matches(value, modelExpectedKwh)) { stats.matchedIntervals++; stats.days.add(sun.day); }
        else if (value === undefined || !Number.isFinite(value) || value < 0) member.excluded.missingOrInvalidReading++;
        else member.excluded.outsideModelBand++;
        member.windows.set(sun.window, stats);
      }
    }
    for (const member of members) {
      const windows = [...member.windows].map(([window, stats]) => {
        const matchedHours = stats.matchedIntervals * hours, agreementFraction = stats.matchedIntervals / stats.eligibleIntervals;
        const qualified = stats.days.size >= PEER_METHOD.qualification.minimumDays && matchedHours + 1e-9 >= PEER_METHOD.qualification.minimumHours &&
          agreementFraction + 1e-9 >= PEER_METHOD.qualification.minimumAgreementFraction;
        if (qualified) member.qualifiedWindows.add(window);
        return { window, eligibleIntervals: stats.eligibleIntervals, matchedIntervals: stats.matchedIntervals, matchedDays: stats.days.size, matchedHours, agreementFraction, qualified };
      });
      records.push({ equipmentId: member.id, qualified: !!member.qualifiedWindows.size, windows, excluded: member.excluded });
      member.index = 0;
    }
    const days = new Map<string, Set<string>>();
    for (const sun of daylight) {
      if (sun.status !== "available") continue;
      const modelExpectedKwh = Math.min(group.acKw, group.dcKw * sun.rate) * hours;
      if (modelExpectedKwh < group.acKw * hours * .1) continue;
      const eligible: { id: string; value: number; reference: boolean }[] = [];
      for (const member of members) {
        const value = sample(member, sun);
        if (value !== undefined && Number.isFinite(value) && value > 0 && value < group.acKw * hours * PEER_METHOD.maximumPeerOutputFraction &&
          sun.rate < (model.inverters.get(member.id)?.referenceYieldLimit ?? 0) - 1e-9 && !blocked.get(member.id)?.has(sun.timestamp))
          eligible.push({ id: member.id, value, reference: member.qualifiedWindows.has(sun.window) && matches(value, modelExpectedKwh) });
      }
      eligible.sort((a, b) => a.value - b.value);
      const references = eligible.filter(p => p.reference);
      for (const target of eligible) {
        const others = references.filter(p => p.id !== target.id);
        if (others.length < PEER_METHOD.minimumPeers) { insufficientReferenceIntervals++; continue; }
        const center = mid(others.map(p => p.value));
        const agreed = others.filter(p => Math.abs(p.value / center - 1) <= PEER_METHOD.maximumPeerDeviationFraction + 1e-9);
        if (agreed.length < PEER_METHOD.minimumPeers) { insufficientReferenceIntervals++; continue; }
        const expectedKwh = mid(agreed.map(p => p.value));
        if (expectedKwh < group.acKw * hours * 0.1) continue;
        comparedInverterIntervals++;
        const ratio = target.value / expectedKwh;
        if (ratio >= 0.95 && ratio <= 1.1) {
          const recovered = recoveryDays.get(target.id) || new Set<string>();
          recovered.add(sun.day); recoveryDays.set(target.id, recovered);
        }
        if (ratio > 1 - PEER_METHOD.minimumDeficitPercent / 100 + 1e-9) continue;
        const finding = findings.get(target.id) || { group, intervals: new Map<string, PeerInterval>(), qualifiedDays: 0, deficitHours: 0 };
        const peerIds = agreed.map(p => p.id).sort(), referenceKey = JSON.stringify(peerIds);
        let peerSetIndex = referenceIndexes.get(referenceKey);
        if (peerSetIndex === undefined) { peerSetIndex = referenceSets.length; referenceSets.push(peerIds); referenceIndexes.set(referenceKey, peerSetIndex); }
        finding.intervals.set(sun.timestamp, { expectedKwh, modelExpectedKwh, actualToPeerRatio: ratio, peerSetIndex, peerCount: peerIds.length });
        const affected = days.get(target.id) || new Set<string>(); affected.add(sun.day); days.set(target.id, affected);
        finding.qualifiedDays = affected.size; finding.deficitHours += hours; findings.set(target.id, finding);
      }
    }
  }
  for (const [id, finding] of findings) if (finding.qualifiedDays < PEER_METHOD.minimumDays || finding.deficitHours + 1e-9 < PEER_METHOD.minimumDeficitHours) findings.delete(id);
  const qualifiedInverters = records.filter(r => r.qualified).length;
  const unavailable = !comparedInverterIntervals;
  const status = unavailable ? "unavailable" : insufficientReferenceIntervals || expectedData.missing || expectedData.invalid || expectedData.capacityConflict ? "limited" : "available";
  const reason = !model.ready ? "Complete the array model before qualifying references." : !expectedData.available ? "No usable site Expected Production overlaps eligible daylight intervals." :
    "Fewer than two qualifying, capacity-matched references were available for some or all inverter intervals.";
  const message = (unavailable ? "Optional peer corroboration unavailable. " + reason : status === "limited" ? "Optional peer corroboration has limited coverage. " + reason : "Optional peer corroboration used references qualified against derived inverter expectations.") +
    (expectedData.capacityConflict ? ` ${expectedData.capacityConflict} daylight expected-production intervals exceed the configured site export ceiling and were excluded.` : "") +
    " Primary model-derived detection does not require peer references.";
  return { groups, findings, recoveryDays, referenceSets, referenceQualification: { status, message, modelIssues: model.issues,
    deliveryFactor: model.deliveryFactor, gridExportCeilingKw: model.gridExportCeilingKw, qualifiedInverters, comparedInverterIntervals,
    insufficientReferenceIntervals, expectedData, records } };
}
