import { getBucketBinding, getDatabaseBinding } from "./binding";

export const ACTIVE_SITE_ID = "juniper-plains";
export const REMOVED_SITE_IDS = ["red-mesa", "longleaf", "silver-creek"] as const;
const PERFORMANCE_SITE_IDS = [...REMOVED_SITE_IDS, ACTIVE_SITE_ID];
const CLEANUP_ID = "remove-placeholder-sites-and-performance-v1";

let cleanupPromise: Promise<void> | null = null;

async function tableExists(database: D1Database, tableName: string) {
  const result = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(tableName).first();
  return Boolean(result);
}

async function runCleanup() {
  const database = getDatabaseBinding();
  await database.prepare(`CREATE TABLE IF NOT EXISTS maintenance_tasks (
    id text PRIMARY KEY NOT NULL,
    status text NOT NULL,
    completed_at text NOT NULL
  )`).run();

  const completed = await database.prepare("SELECT status FROM maintenance_tasks WHERE id = ?").bind(CLEANUP_ID).first<{ status: string }>();
  if (completed?.status === "completed") return;

  const telemetryTableExists = await tableExists(database, "telemetry_imports");
  const settingsTableExists = await tableExists(database, "site_settings");
  const equipmentTableExists = await tableExists(database, "equipment_assets");

  if (telemetryTableExists) {
    const placeholders = PERFORMANCE_SITE_IDS.map(() => "?").join(", ");
    const records = await database.prepare(`SELECT object_key FROM telemetry_imports WHERE site_id IN (${placeholders})`).bind(...PERFORMANCE_SITE_IDS).all<{ object_key: string }>();
    const objectKeys = records.results.map(record => record.object_key).filter(Boolean);
    const bucket = getBucketBinding();
    for (let index = 0; index < objectKeys.length; index += 1000) {
      await bucket.delete(objectKeys.slice(index, index + 1000));
    }
  }

  const statements: D1PreparedStatement[] = [];
  if (telemetryTableExists) statements.push(database.prepare("DELETE FROM telemetry_imports WHERE site_id IN (?, ?, ?, ?)").bind(...PERFORMANCE_SITE_IDS));
  if (settingsTableExists) statements.push(database.prepare("DELETE FROM site_settings WHERE id IN (?, ?, ?)").bind(...REMOVED_SITE_IDS));
  if (equipmentTableExists) statements.push(database.prepare("DELETE FROM equipment_assets WHERE site_id IN (?, ?, ?)").bind(...REMOVED_SITE_IDS));
  statements.push(database.prepare("INSERT OR REPLACE INTO maintenance_tasks (id, status, completed_at) VALUES (?, 'completed', ?)").bind(CLEANUP_ID, new Date().toISOString()));
  await database.batch(statements);
}

export function ensureLegacyPortfolioCleanup() {
  if (!cleanupPromise) cleanupPromise = runCleanup().catch(error => {
    cleanupPromise = null;
    throw error;
  });
  return cleanupPromise;
}

export function isActiveSiteId(siteId: string) {
  return siteId === ACTIVE_SITE_ID;
}
