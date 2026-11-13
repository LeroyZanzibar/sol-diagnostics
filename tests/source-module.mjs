import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

export function loadSource(path, names = [], bindings = {}) {
  const original = readFileSync(path, "utf8");
  const parsed = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true);
  const source = parsed.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getFullText(parsed)).join("\n");
  const output = ts.transpileModule(source + `\nglobalThis.testExports = { ${names.join(",")} };`, {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    transformers: { before: [context => root => ts.visitNode(root, function visit(node) {
      if (ts.isImportDeclaration(node)) return undefined;
      return ts.visitEachChild(node, visit, context);
    })] },
  }).outputText;
  const context = vm.createContext({ exports: {}, console, crypto: webcrypto, TextEncoder, TextDecoder,
    URL, Request, Response, Headers, Blob, File, ReadableStream, CompressionStream, DecompressionStream, setTimeout, clearTimeout, ...bindings });
  vm.runInContext(output, context);
  return { ...context.exports, ...context.testExports };
}

let capacityBindings;
export function modelCapacityBindings() {
  if (!capacityBindings) {
    const model=loadSource("app/array-capacity.ts");
    const time=loadSource("app/telemetry-time.ts"),periods=loadSource("app/issue-periods.ts",[],time);
    capacityBindings={...model,...loadSource("app/recurring-issues.ts",[],{...time,...periods}),...loadSource("app/api/performance-summary/transformer-limits.ts",[],model),
      ...loadSource("app/api/performance-summary/inverter-expectation.ts",[],model),
      ...loadSource("app/api/performance-summary/shared-underperformance.ts")};
  }
  return capacityBindings;
}

export function makeAnalysisFixture(days = 50, inverterCount = 4, seed = 0) {
  const asset = (id, type, parentId = null) => ({ id, type, parentId, name: id, externalId: id,
    acRatedCapacityKw: "100", moduleRatedCapacityW: "400", quantity: 250,
    acLineLossPercent: "2", transformerLossPercent: "1", aliases: "[]", updatedAt: "2026-01-01" });
  const equipment = [asset("meter", "revenue_meter")];
  for (let i = 0; i < inverterCount; i++) equipment.push(asset(`inv${i}`, "inverter", "meter"), asset(`modules${i}`, "module_group", `inv${i}`));
  const productionAssets = equipment.filter(item => item.type !== "module_group");
  const equipmentProduction = productionAssets.map(item => ({ equipmentId: item.id, equipmentName: item.name,
    equipmentType: item.type, externalId: item.id, capacityKw: item.type === "revenue_meter" ? inverterCount * 97.02 : 100,
    source: "interval_energy", intervalProduction: [], dailyProduction: [], readingCount: 0 }));
  const summary = { intervalMinutes: 60, intervalIrradiance: [], expectedProduction: [], equipmentProduction,
    dailyProduction: [], totalEnergyKwh: 0, latestDate: "", latestDayEnergyKwh: 0, readingCount: 0, source: "interval_energy",
    revenueMeterFallback: { equipmentId: "meter", points: [] } };
  for (let day = 0; day < days; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const timestamp = new Date(Date.UTC(2026, 0, day + 1, hour)).toISOString().slice(0, 19);
      const sunlight = hour >= 7 && hour <= 17 ? (day % 13 === 0 ? 30 : 600) : 0;
      // Include a missing irradiance interval, extended outages, partial losses and gaps.
      if (!(day % 11 === 0 && hour === 10)) summary.intervalIrradiance.push({ timestamp, averageWm2: sunlight, insolationKwhM2: sunlight / 1000, peakWm2: sunlight, readingCount: 1 });
      summary.expectedProduction.push({ timestamp, energyKwh: sunlight / 1000 * 80 * inverterCount });
      let fleet = 0;
      for (let i = 0; i < inverterCount; i++) {
        let energyKwh = sunlight / 1000 * 80;
        if ((day + i + seed) % 17 < 3) energyKwh = 0;
        else if ((day + i + seed) % 7 === 0) energyKwh *= 0.35;
        if (day % 19 === 5) energyKwh = 0;
        if (!(day % 9 === 0 && i === 1 && hour === 11)) equipmentProduction[i + 1].intervalProduction.push({ timestamp, energyKwh });
        fleet += energyKwh;
      }
      const energyKwh = fleet * 0.9702 * (day % 23 === 2 ? 0.4 : 1);
      equipmentProduction[0].intervalProduction.push({ timestamp, energyKwh });
      if (day % 21 === 8 && sunlight > 50) summary.revenueMeterFallback.points.push({ timestamp, energyKwh, inverterAggregateEnergyKwh: fleet, wasMissing: hour % 2 === 0 });
    }
  }
  return { equipment, summary };
}
