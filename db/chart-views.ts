import {sqliteTable, text, uniqueIndex} from 'drizzle-orm/sqlite-core';
import type {ChartSettings, SavedChartView} from '../app/chart-types';
import {validateChartSettings} from '../app/monthly-chart-model';
import {getDatabaseBinding} from './binding';
import type {SynchronousDatabaseWriter} from './binding';

export const chartViews = sqliteTable('chart_views', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull(),
  settingsJson: text('settings_json').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [uniqueIndex('chart_views_user_name_key_unique').on(table.userId, table.nameKey)]);

// App-profile storage, matching user-settings; this is not account isolation.
// No foreign key to user_settings: a view can be saved before profile setup.
const USER_ID = 'primary-user';
const MAX_VIEWS = 100;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const selectColumns = 'id, user_id, name, name_key, settings_json, created_at';
type ChartViewRow = {
  id: string; user_id: string; name: string; name_key: string;
  settings_json: string; created_at: string;
};

export class ChartViewError extends Error {
  status: 400 | 409 | 500;
  constructor(message: string, status: 400 | 409 | 500 = 400) {
    super(message);
    this.name = 'ChartViewError';
    this.status = status;
  }
}

function validateName(input: unknown): string {
  if (typeof input !== 'string' || controlCharacters.test(input)) {
    throw new ChartViewError('Use a view name without control characters.');
  }
  const name = input.trim();
  if (!name || Array.from(name).length > 60) {
    throw new ChartViewError('Use a view name with 1–60 characters.');
  }
  return name;
}

export function validateChartViewInput(input: unknown): {name: string; settings: ChartSettings} {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => key !== 'name' && key !== 'settings')) {
    throw new ChartViewError('Provide only a name and chart settings.');
  }
  const body = input as Record<string, unknown>;
  const name = validateName(body.name);
  let settings: ChartSettings;
  try {
    // The model owns the metric inventory, date bounds and saved-state rules.
    settings = validateChartSettings(body.settings);
  } catch (error) {
    const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message : 'Provide valid chart settings.';
    throw new ChartViewError(message);
  }
  return {name, settings};
}

function decodeStoredView(row: ChartViewRow): SavedChartView {
  try {
    if (typeof row.id !== 'string' || !row.id || controlCharacters.test(row.id)
      || row.user_id !== USER_ID || typeof row.created_at !== 'string'
      || new Date(row.created_at).toISOString() !== row.created_at
      || typeof row.settings_json !== 'string') throw new Error('Invalid stored metadata.');
    const {name, settings} = validateChartViewInput({name: row.name, settings: JSON.parse(row.settings_json)});
    if (name !== row.name || name.toLowerCase() !== row.name_key) throw new Error('Invalid stored name.');
    return {id: row.id, name, settings, createdAt: row.created_at};
  } catch {
    // Do not turn corruption into a silently shortened or apparently empty list.
    throw new ChartViewError('A saved chart view contains an unreadable record. Saved data was not changed.', 500);
  }
}

export async function listChartViews(): Promise<SavedChartView[]> {
  const result = await getDatabaseBinding().prepare(
    `SELECT ${selectColumns} FROM chart_views WHERE user_id = ? ORDER BY created_at ASC, id ASC`,
  ).bind(USER_ID).all<ChartViewRow>();
  return result.results.map(decodeStoredView);
}

export function createChartView(input: unknown): SavedChartView {
  const {name, settings} = validateChartViewInput(input);
  const db = getDatabaseBinding();
  if (!db.withSynchronousWrite) {
    throw new ChartViewError('Atomic saved chart view storage is unavailable.', 500);
  }
  // Production LocalDatabase uses BEGIN IMMEDIATE with a synchronous callback.
  // Duplicate and capacity checks, insert and verified readback are one commit;
  // no await lets another request join the transaction or bypass the limit.
  return db.withSynchronousWrite((write: SynchronousDatabaseWriter) => {
    const nameKey = name.toLowerCase();
    if (write.first('SELECT id FROM chart_views WHERE user_id = ? AND name_key = ?', USER_ID, nameKey)) {
      throw new ChartViewError('A saved chart view with that name already exists. Choose a different name.', 409);
    }
    const count = write.first<{count: number}>('SELECT COUNT(*) AS count FROM chart_views WHERE user_id = ?', USER_ID);
    if (!count || count.count >= MAX_VIEWS) {
      throw new ChartViewError('You can save up to 100 chart views. No additional view was saved.', 409);
    }
    const id = crypto.randomUUID(), createdAt = new Date().toISOString(), settingsJson = JSON.stringify(settings);
    write.run('INSERT INTO chart_views (id, user_id, name, name_key, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, USER_ID, name, nameKey, settingsJson, createdAt);
    const row = write.first<ChartViewRow>(`SELECT ${selectColumns} FROM chart_views WHERE id = ? AND user_id = ?`, id, USER_ID);
    if (!row || row.name !== name || row.name_key !== nameKey || row.settings_json !== settingsJson || row.created_at !== createdAt) {
      throw new ChartViewError('Unable to verify the saved chart view. No view was saved.', 500);
    }
    return decodeStoredView(row);
  });
}
