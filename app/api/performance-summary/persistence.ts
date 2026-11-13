import { retryDatabaseWrite } from "./database-errors";

type IssueDatabaseStatement = {
  bind(...values: unknown[]): IssueDatabaseStatement;
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T>(): Promise<{ results: T[] }>;
};

type IssueDatabase = {
  prepare(query: string): IssueDatabaseStatement;
  batch(statements: IssueDatabaseStatement[]): Promise<unknown>;
};

type PersistableIssue = {
  id: string;
  databaseId?: string;
  status?: string;
  name: string;
  type: string;
  category: string;
  confidence: string;
  severity: string;
  equipmentId: string;
  equipmentName: string;
  equipmentType: string;
  equipmentExternalId: string;
  startDateTime: string;
  endDateTime: string;
  durationMinutes: number;
  durationDays: number;
  lossUnknown?: boolean;
  productionUnknown?: boolean;
  affectedEquipment?: { id: string; name: string }[];
  estimatedLossKwh: number;
  lossPercent: number;
  siteImpactPercent: number;
  actualEnergyKwh: number;
  expectedEnergyKwh: number;
  description: string;
  evidence?: Record<string, unknown>;
};

type PersistArguments = {
  database: IssueDatabase;
  siteId: string;
  importId: string;
  parserVersion: number;
  modelRevision: string;
  analysisObjectKey: string;
  issues: PersistableIssue[];
  runIdOverride?: string;
  append?: boolean;
  checkpoint?: () => Promise<void>;
};

type AnalysisRunArguments = Omit<PersistArguments, "issues">;

type PersistedIssueRow = {
  source_issue_id: string;
  database_issue_id: string;
  status: string;
  name: string;
  issue_type: string;
  category: string;
  confidence: string;
  severity: string;
  equipment_id: string;
  equipment_name: string;
  equipment_type: string;
  equipment_external_id: string;
  start_date_time: string;
  end_date_time: string;
  duration_minutes: number;
  actual_energy_kwh: number;
  expected_energy_kwh: number;
  estimated_loss_kwh: number | null;
  loss_percent: number | null;
  site_impact_percent: number;
  description: string;
  evidence: string;
};

type PreparedIssue = {
  issue: PersistableIssue;
  issueId: string;
  fingerprint: string;
  occurrenceId: string;
};

const BATCH_SIZE = 60;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function stableId(prefix: string, value: string) {
  return `${prefix}-${(await sha256(value)).slice(0, 32)}`;
}

async function performanceAnalysisRunId(
  importId: string,
  parserVersion: number,
  modelRevision: string,
) {
  return stableId("analysis", `${importId}|${parserVersion}|${modelRevision}`);
}

export async function claimPerformanceAnalysis({
  database,
  siteId,
  importId,
  parserVersion,
  modelRevision,
  analysisObjectKey,
}: AnalysisRunArguments) {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 360_000).toISOString();
  const runId = await performanceAnalysisRunId(
    importId,
    parserVersion,
    modelRevision,
  );
  const result = await database.prepare(`
    INSERT INTO analysis_runs (
      id, site_id, import_id, parser_version, model_revision, status,
      issue_count, analysis_object_key, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'processing', 0, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'processing',
      issue_count = 0,
      analysis_object_key = excluded.analysis_object_key,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at
    WHERE analysis_runs.status <> 'processing'
      OR analysis_runs.started_at < ?
    RETURNING id
  `).bind(
    runId,
    siteId,
    importId,
    parserVersion,
    modelRevision,
    analysisObjectKey,
    now,
    now,
    staleBefore,
  ).all<{ id: string }>();
  return { runId, acquired: result.results.length === 1 };
}

export async function failPerformanceAnalysis(
  database: IssueDatabase,
  runId: string,
) {
  await database.prepare(`
    UPDATE analysis_runs
    SET status = 'failed', completed_at = ?
    WHERE id = ? AND status = 'processing'
  `).bind(new Date().toISOString(), runId).run();
}

export async function completePerformanceAnalysis(
  database: IssueDatabase,
  runId: string,
  issueCount: number,
  analysisObjectKey: string,
) {
  await database.prepare(`
    UPDATE analysis_runs SET
      status = 'completed',
      issue_count = ?,
      analysis_object_key = ?,
      completed_at = ?
    WHERE id = ?
  `).bind(
    issueCount,
    analysisObjectKey,
    new Date().toISOString(),
    runId,
  ).run();
}

async function executeBatches(database: IssueDatabase, statements: IssueDatabaseStatement[], checkpoint?: () => Promise<void>) {
  for (let index = 0; index < statements.length; index += BATCH_SIZE) {
    await checkpoint?.();
    await retryDatabaseWrite(`issue batch ${index / BATCH_SIZE + 1}`,
      () => database.batch(statements.slice(index, index + BATCH_SIZE)), checkpoint);
  }
}

function safeJson<T>(value: string, fallback: T) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function persistPerformanceIssues({
  database,
  siteId,
  importId,
  parserVersion,
  modelRevision,
  analysisObjectKey,
  issues,
  runIdOverride, append = false, checkpoint,
}: PersistArguments) {
  const now = new Date().toISOString();
  const runId = runIdOverride || await performanceAnalysisRunId(
    importId,
    parserVersion,
    modelRevision,
  );
  await checkpoint?.();
  const prepared = await Promise.all(issues.map(async issue => {
    const fingerprint = await sha256(`${siteId}|${issue.equipmentId}|${issue.category}|${issue.type}`);
    const issueId = `issue-${fingerprint.slice(0, 32)}`;
    const occurrenceId = await stableId("occurrence", `${runId}|${issue.id}`);
    return { issue, issueId, fingerprint, occurrenceId } satisfies PreparedIssue;
  }));

  await retryDatabaseWrite("analysis run", () => database.prepare(`
    INSERT INTO analysis_runs (
      id, site_id, import_id, parser_version, model_revision, status,
      issue_count, analysis_object_key, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'processing', 0, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).bind(
    runId,
    siteId,
    importId,
    parserVersion,
    modelRevision,
    analysisObjectKey,
    now,
    now,
  ).run(), checkpoint);

  if (!append) await database.prepare(`
    DELETE FROM performance_issue_occurrences
    WHERE analysis_run_id = ?
  `).bind(runId).run();

  const upserts: IssueDatabaseStatement[] = [];
  prepared.forEach(({ issue, issueId, fingerprint, occurrenceId }) => {
    const loss = issue.lossUnknown ? null : issue.estimatedLossKwh;
    const lossPercent = issue.lossUnknown ? null : issue.lossPercent;
    const evidence = JSON.stringify({
      ...(issue.evidence || {}),
      ...(issue.evidence?.evidenceKey ? {intervalLosses:undefined} : {}),
      sourceIssueId: issue.id,
      analysisRunId: runId,
    });

    upserts.push(database.prepare(`
      INSERT INTO performance_issues (
        id, fingerprint, site_id, equipment_id, equipment_name,
        equipment_external_id, equipment_type, name, issue_type, category,
        confidence, severity, description, status, first_detected_at,
        last_detected_at, occurrence_count, latest_estimated_loss_kwh,
        latest_site_impact_percent, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        equipment_name = excluded.equipment_name,
        equipment_external_id = excluded.equipment_external_id,
        equipment_type = excluded.equipment_type,
        name = excluded.name,
        issue_type = excluded.issue_type,
        category = excluded.category,
        confidence = excluded.confidence,
        severity = excluded.severity,
        description = excluded.description,
        first_detected_at = MIN(performance_issues.first_detected_at, excluded.first_detected_at),
        last_detected_at = MAX(performance_issues.last_detected_at, excluded.last_detected_at),
        latest_estimated_loss_kwh = excluded.latest_estimated_loss_kwh,
        latest_site_impact_percent = excluded.latest_site_impact_percent,
        updated_at = excluded.updated_at
    `).bind(
      issueId,
      fingerprint,
      siteId,
      issue.equipmentId,
      issue.equipmentName,
      issue.equipmentExternalId,
      issue.equipmentType,
      issue.name,
      issue.type,
      issue.category,
      issue.confidence,
      issue.severity,
      issue.description,
      issue.startDateTime,
      issue.endDateTime,
      loss,
      issue.siteImpactPercent,
      now,
      now,
    ));

    upserts.push(database.prepare(`
      INSERT INTO performance_issue_occurrences (
        id, issue_id, analysis_run_id, import_id, site_id, source_issue_id,
        start_date_time, end_date_time, duration_minutes, actual_energy_kwh,
        expected_energy_kwh, estimated_loss_kwh, loss_percent,
        site_impact_percent, evidence, parser_version, model_revision,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        start_date_time = excluded.start_date_time,
        end_date_time = excluded.end_date_time,
        duration_minutes = excluded.duration_minutes,
        actual_energy_kwh = excluded.actual_energy_kwh,
        expected_energy_kwh = excluded.expected_energy_kwh,
        estimated_loss_kwh = excluded.estimated_loss_kwh,
        loss_percent = excluded.loss_percent,
        site_impact_percent = excluded.site_impact_percent,
        evidence = excluded.evidence,
        parser_version = excluded.parser_version,
        model_revision = excluded.model_revision,
        updated_at = excluded.updated_at
    `).bind(
      occurrenceId,
      issueId,
      runId,
      importId,
      siteId,
      issue.id,
      issue.startDateTime,
      issue.endDateTime,
      issue.durationMinutes,
      issue.actualEnergyKwh,
      issue.expectedEnergyKwh,
      loss,
      lossPercent,
      issue.siteImpactPercent,
      evidence,
      parserVersion,
      modelRevision,
      now,
      now,
    ));
  });
  await executeBatches(database, upserts, checkpoint);

  const refreshStatements = [...new Set(prepared.map(item => item.issueId))].map(issueId => database.prepare(`
    UPDATE performance_issues SET
      first_detected_at = COALESCE((
        SELECT MIN(start_date_time) FROM performance_issue_occurrences WHERE issue_id = ?
      ), first_detected_at),
      last_detected_at = COALESCE((
        SELECT MAX(end_date_time) FROM performance_issue_occurrences WHERE issue_id = ?
      ), last_detected_at),
      occurrence_count = (
        SELECT COUNT(*) FROM performance_issue_occurrences WHERE issue_id = ?
      ),
      latest_estimated_loss_kwh = (
        SELECT estimated_loss_kwh FROM performance_issue_occurrences
        WHERE issue_id = ? ORDER BY end_date_time DESC, updated_at DESC LIMIT 1
      ),
      latest_site_impact_percent = COALESCE((
        SELECT site_impact_percent FROM performance_issue_occurrences
        WHERE issue_id = ? ORDER BY end_date_time DESC, updated_at DESC LIMIT 1
      ), latest_site_impact_percent),
      updated_at = ?
    WHERE id = ?
  `).bind(issueId, issueId, issueId, issueId, issueId, now, issueId));
  await executeBatches(database, refreshStatements, checkpoint);

  return { runId, persistedIssueCount: prepared.length };
}

// Finalization needs identities only; the immutable checkpoint already holds
// all descriptions, evidence and calculated values for this particular run.
export async function readPerformanceIssueReferences(database: IssueDatabase, runId: string) {
  const result = await database.prepare(`
    SELECT source_issue_id AS id, issue_id AS databaseId
    FROM performance_issue_occurrences WHERE analysis_run_id = ?
  `).bind(runId).all<{ id: string; databaseId: string }>();
  return result.results;
}

export async function readPersistedPerformanceIssues(database: IssueDatabase, runId: string) {
  const result = await database.prepare(`
    SELECT
      occurrence.source_issue_id,
      issue.id AS database_issue_id,
      issue.status,
      issue.name,
      issue.issue_type,
      issue.category,
      issue.confidence,
      issue.severity,
      issue.equipment_id,
      issue.equipment_name,
      issue.equipment_type,
      issue.equipment_external_id,
      occurrence.start_date_time,
      occurrence.end_date_time,
      occurrence.duration_minutes,
      occurrence.actual_energy_kwh,
      occurrence.expected_energy_kwh,
      occurrence.estimated_loss_kwh,
      occurrence.loss_percent,
      occurrence.site_impact_percent,
      issue.description,
      occurrence.evidence
    FROM performance_issue_occurrences AS occurrence
    INNER JOIN performance_issues AS issue ON issue.id = occurrence.issue_id
    WHERE occurrence.analysis_run_id = ?
    ORDER BY COALESCE(occurrence.estimated_loss_kwh, -1) DESC, occurrence.start_date_time ASC
  `).bind(runId).all<PersistedIssueRow>();

  return result.results.map(row => ({
    id: row.source_issue_id,
    databaseId: row.database_issue_id,
    status: row.status,
    name: row.name,
    type: row.issue_type,
    category: row.category,
    confidence: row.confidence,
    severity: row.severity,
    equipmentId: row.equipment_id,
    equipmentName: row.equipment_name,
    equipmentType: row.equipment_type,
    equipmentExternalId: row.equipment_external_id,
    startDateTime: row.start_date_time,
    endDateTime: row.end_date_time,
    durationMinutes: Number(row.duration_minutes),
    durationDays: Number(row.duration_minutes) / 1440,
    estimatedLossKwh: row.estimated_loss_kwh == null ? 0 : Number(row.estimated_loss_kwh),
    lossPercent: row.loss_percent == null ? 0 : Number(row.loss_percent),
    siteImpactPercent: Number(row.site_impact_percent),
    actualEnergyKwh: Number(row.actual_energy_kwh),
    expectedEnergyKwh: Number(row.expected_energy_kwh),
    description: row.description,
    lossUnknown: safeJson<{ lossUnknown?: boolean }>(row.evidence, {}).lossUnknown || false,
    productionUnknown: safeJson<{ productionUnknown?: boolean }>(row.evidence, {}).productionUnknown || false,
    affectedEquipment: safeJson<{ affectedEquipment?: { id: string; name: string }[] }>(row.evidence, {}).affectedEquipment,
    suspectedCause: safeJson<{ suspectedCause?: string }>(row.evidence, {}).suspectedCause || "",
    causeExplanation: safeJson<{ causeExplanation?: string }>(row.evidence, {}).causeExplanation || "",
    evidence: safeJson<Record<string, unknown>>(row.evidence, {}),
  }));
}
