import {DatabaseSync} from 'node:sqlite';
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {mkdirSync, realpathSync, lstatSync, openSync, closeSync, constants} from 'node:fs';
import {join, resolve} from 'node:path';
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';

// Limits apply to consumed input (including duplicate rows), not just its deduped
// result. No transaction or SQLite cursor remains open across an await/yield.
const BATCH_SIZE = 500;
const BATCH_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_ROWS = 5_000_000;
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_CHANNELS = 10_000;
const MAX_ACTIVE_STAGES = 8;
const MAX_OPEN_SITES = 64;
const MAX_ITERATORS = 64;
const STAGE_TTL_MS = 60 * 60 * 1000;
const CANCELED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CANCELED_PREVIEWS = 128;
const SAMPLE_LIMIT = 20;

function failure(code, message, status = 400) {
  return Object.assign(new Error(message), {code, status, statusCode: status});
}
function check(condition, code, message, status) {if (!condition) throw failure(code, message, status);}
function text(value, max = 4096, allowEmpty = false) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.isWellFormed() && !value.includes('\0') && Buffer.byteLength(value) <= max;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const nowISO = () => new Date(Date.now()).toISOString();
function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {const result = work(); db.exec('COMMIT'); return result;}
  catch (error) {try {db.exec('ROLLBACK');} catch {} throw error;}
}

// Keep applied SQL byte-for-byte stable. Future changes are new additive entries.
const LEDGER_SQL = 'CREATE TABLE __performance_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL) STRICT';
const MIGRATIONS = [
  {version: 1, sql: `
    CREATE TABLE site_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      site_id TEXT NOT NULL, site_hash TEXT NOT NULL, head_revision INTEGER NOT NULL CHECK(head_revision>=0)
    ) STRICT;
    CREATE TABLE revisions (
      revision INTEGER PRIMARY KEY CHECK(revision>=0), revision_id TEXT NOT NULL UNIQUE,
      dataset_json TEXT NOT NULL CHECK(json_valid(dataset_json))
    ) STRICT;
    CREATE TABLE channels (
      id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL, measurement TEXT NOT NULL, unit TEXT NOT NULL
    ) STRICT;
    CREATE TABLE readings (
      timestamp TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id),
      value_json TEXT NOT NULL CHECK(json_valid(value_json)), revision INTEGER NOT NULL REFERENCES revisions(revision),
      PRIMARY KEY(timestamp, channel_id)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE reading_versions (
      timestamp TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id), revision INTEGER NOT NULL REFERENCES revisions(revision),
      value_json TEXT NOT NULL CHECK(json_valid(value_json)), previous_value_json TEXT,
      incoming_value_json TEXT NOT NULL CHECK(json_valid(incoming_value_json)),
      PRIMARY KEY(timestamp, channel_id, revision)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX reading_versions_revision ON reading_versions(revision);
    CREATE TABLE stages (
      stage_id TEXT PRIMARY KEY NOT NULL, token TEXT NOT NULL, base_revision INTEGER NOT NULL REFERENCES revisions(revision),
      status TEXT NOT NULL CHECK(status IN ('loading','preview','committed','canceled')),
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)), created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      preview_json TEXT, result_json TEXT, canceled_reason TEXT
    ) STRICT;
    CREATE INDEX stages_expiry ON stages(status, expires_at);
    CREATE TABLE staged_channels (
      stage_id TEXT NOT NULL REFERENCES stages(stage_id) ON DELETE CASCADE,
      id TEXT NOT NULL, equipment_id TEXT NOT NULL, measurement TEXT NOT NULL, unit TEXT NOT NULL,
      PRIMARY KEY(stage_id, id)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE staged_readings (
      stage_id TEXT NOT NULL, timestamp TEXT NOT NULL, channel_id TEXT NOT NULL,
      value_json TEXT NOT NULL CHECK(json_valid(value_json)), PRIMARY KEY(stage_id, timestamp, channel_id),
      FOREIGN KEY(stage_id, channel_id) REFERENCES staged_channels(stage_id, id) ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE imports (
      stage_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL UNIQUE REFERENCES revisions(revision),
      result_json TEXT NOT NULL CHECK(json_valid(result_json)), metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
      actor TEXT NOT NULL, overlap_approved INTEGER NOT NULL CHECK(overlap_approved IN (0,1))
    ) STRICT;
  `},
  {version: 2, sql: `
    CREATE TABLE analyses (
      run_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL REFERENCES revisions(revision),
      provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
    ) STRICT;
  `},
];
const SCHEMA_VERSION = MIGRATIONS.length;
const SCHEMA_QUERY = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
let manifests;
function expectedSchemas() {
  if (manifests) return manifests;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(LEDGER_SQL);
    manifests = new Map();
    for (const migration of MIGRATIONS) {
      db.exec(migration.sql);
      manifests.set(migration.version, canonicalJSON(db.prepare(SCHEMA_QUERY).all()));
    }
    return manifests;
  } finally {db.close();}
}
function validateSchema(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const schema = db.prepare(SCHEMA_QUERY).all();
  check(Number.isInteger(version) && version >= 0 && version <= SCHEMA_VERSION, 'INCOMPATIBLE_SCHEMA', 'Unsupported performance schema version; startup refused.', 500);
  if (version === 0) {
    check(schema.length === 0, 'INCOMPATIBLE_SCHEMA', 'Refusing to adopt an unversioned or foreign database.', 500);
    return 0;
  }
  check(canonicalJSON(schema) === expectedSchemas().get(version), 'INCOMPATIBLE_SCHEMA', 'Performance schema objects or constraints are incompatible; startup refused.', 500);
  const applied = db.prepare('SELECT version,checksum FROM __performance_migrations ORDER BY version').all();
  check(applied.length === version && applied.every((entry, index) => entry.version === MIGRATIONS[index].version && entry.checksum === digest(MIGRATIONS[index].sql)), 'INCOMPATIBLE_SCHEMA', 'Performance migration ledger does not match this application.', 500);
  return version;
}
function ownership(db, siteId, siteHash) {
  const rows = db.prepare('SELECT * FROM site_state').all();
  check(rows.length === 1 && rows[0].site_id === siteId && rows[0].site_hash === siteHash, 'SITE_OWNERSHIP_MISMATCH', 'This performance database belongs to a different exact site ID.', 409);
  const revision = db.prepare('SELECT revision_id,dataset_json FROM revisions WHERE revision=?').get(rows[0].head_revision);
  check(revision && revision.revision_id === `${siteHash}:${rows[0].head_revision}` && JSON.parse(revision.dataset_json).siteId === siteId, 'INCOMPATIBLE_SCHEMA', 'Performance head revision is missing or inconsistent.', 500);
}
function safeFile(filename) {
  // Refuse file/sidecar symlinks and hardlinks; directory ownership is the host's
  // trust boundary. Create exclusively with private permissions when absent.
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const stat = lstatSync(filename + suffix);
      check(stat.isFile() && stat.nlink === 1, 'UNSAFE_DATABASE_PATH', 'Performance database files must be regular, unaliased files.', 500);
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  try {closeSync(openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));}
  catch (error) {if (error.code !== 'EEXIST') throw error;}
}
function normalizeTimestamp(value, code = 'INVALID_READING') {
  check(typeof value === 'string', code, 'A reading timestamp must be an explicitly zoned ISO timestamp.');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  check(match, code, 'A timestamp must include seconds and an explicit UTC offset, with at most millisecond precision.');
  const [, year, month, day, hour, minute, second, , offset] = match;
  const local = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  check(local.getUTCFullYear() === Number(year) && local.getUTCMonth() + 1 === Number(month) && local.getUTCDate() === Number(day) && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60, code, 'Invalid calendar date or timestamp.');
  check(offset === 'Z' || (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4)) < 60), code, 'Invalid timestamp offset.');
  const time = Date.parse(value);
  check(Number.isFinite(time), code, 'Invalid timestamp.');
  const normalized = new Date(time).toISOString();
  check(normalized.length === 24, code, 'Timestamp is outside the supported four-digit-year range.');
  return normalized;
}
function normalizeMetadata(metadata) {
  check(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'INVALID_METADATA', 'Import metadata is required.');
  check(['csv', 'api', 'migration'].includes(metadata.source) && text(metadata.fileName) && text(metadata.timezone, 128) && text(metadata.modelRevision), 'INVALID_METADATA', 'Invalid source, file name, timezone or model revision.');
  check(Number.isFinite(metadata.intervalMinutes) && metadata.intervalMinutes > 0 && metadata.intervalMinutes <= 1440 && Number.isSafeInteger(metadata.intervalMinutes * 60000), 'INVALID_METADATA', 'Import cadence must be positive, at most one day, and precise to a millisecond.');
  try {new Intl.DateTimeFormat('en-US', {timeZone: metadata.timezone});}
  catch {throw failure('INVALID_METADATA', 'Import timezone must be a recognized IANA timezone.');}
  const result = {source: metadata.source, fileName: metadata.fileName, timezone: metadata.timezone, intervalMinutes: metadata.intervalMinutes, modelRevision: metadata.modelRevision};
  for (const key of ['sourceImportId', 'originalObjectKey']) {
    if (metadata[key] !== undefined) {check(text(metadata[key]), 'INVALID_METADATA', `Invalid ${key}.`); result[key] = metadata[key];}
  }
  if (metadata.sourceTimestampConvention !== undefined) {
    check(['start', 'end'].includes(metadata.sourceTimestampConvention), 'INVALID_METADATA', 'Invalid source timestamp convention.');
    result.sourceTimestampConvention = metadata.sourceTimestampConvention;
  }
  return result;
}
function normalizeReading(input) {
  check(input && typeof input === 'object', 'INVALID_READING', 'Each reading must be an object.');
  const timestamp = normalizeTimestamp(input.timestamp);
  const c = input.channel;
  check(c && text(c.id, 1024) && text(c.equipmentId, 1024) && text(c.measurement, 512) && text(c.unit, 128, true), 'INVALID_READING', 'Reading channel identity and meaning are required.');
  check(input.value === null || (typeof input.value === 'number' && Number.isFinite(input.value)) || (typeof input.value === 'string' && input.value.isWellFormed() && input.value.length <= 65_536), 'INVALID_READING', 'Reading values must be finite numbers, bounded strings, or null.');
  const channel = {id: c.id, equipmentId: c.equipmentId, measurement: c.measurement, unit: c.unit};
  return {timestamp, channel, valueJSON: JSON.stringify(input.value)};
}
function channelFrom(row) {return {id: row.channel_id ?? row.id, equipmentId: row.equipment_id, measurement: row.measurement, unit: row.unit};}
function sameChannel(saved, incoming) {return saved.id === incoming.id && saved.equipment_id === incoming.equipmentId && saved.measurement === incoming.measurement && saved.unit === incoming.unit;}
function scopeFilter(scope) {
  if (scope === undefined) return {sql: '', params: []};
  check(scope && typeof scope === 'object', 'INVALID_SCOPE', 'An input scope is required.');
  const start = normalizeTimestamp(scope.start, 'INVALID_SCOPE');
  const end = normalizeTimestamp(scope.end, 'INVALID_SCOPE');
  check(start <= end, 'INVALID_SCOPE', 'Scope start must not follow its end.');
  let sql = ' AND v.timestamp>=? AND v.timestamp<=?';
  const params = [start, end];
  for (const [field, column] of [['equipmentIds', 'equipment_id'], ['measurements', 'measurement']]) {
    if (scope[field] !== undefined) {
      check(Array.isArray(scope[field]) && scope[field].length <= 10_000 && Array.from(scope[field]).every(value => text(value, 1024)), 'INVALID_SCOPE', `Invalid ${field} filter.`);
      sql += ` AND c.${column} IN (SELECT value FROM json_each(?))`;
      params.push(JSON.stringify(scope[field]));
    }
  }
  return {sql, params};
}

export class PerformanceStoreManager {
  // Handles remain stable across caller awaits. Only live SQLite connections
  // participate in the bounded LRU; parking a connection never closes its handle.
  #stores = new Map();
  #connections = new Map();
  #closed = false;
  constructor(directory) {
    check(text(directory, 16_384), 'INVALID_DIRECTORY', 'A performance database directory is required.');
    mkdirSync(resolve(directory), {recursive: true, mode: 0o700});
    this.directory = realpathSync(resolve(directory));
  }
  #checkSite(siteId) {
    check(!this.#closed, 'STORE_CLOSED', 'Performance store manager is closed.', 503);
    check(text(siteId), 'INVALID_SITE_ID', 'Site ID must be a nonempty, well-formed string of at most 4096 bytes.');
  }
  #activate(store, connect, park) {
    check(!this.#closed, 'STORE_CLOSED', 'Performance store manager is closed.', 503);
    if (!this.#connections.has(store)) {
      if (this.#connections.size >= MAX_OPEN_SITES) {
        for (const [candidate, tryPark] of this.#connections) {
          if (tryPark()) {this.#connections.delete(candidate); break;}
        }
      }
      check(this.#connections.size < MAX_OPEN_SITES, 'STORE_CAPACITY', 'All site database connections are active; finish or close an import or reader and retry.', 503);
      // A failed open must not consume a slot. Every physical reopen repeats
      // path, schema, migration-ledger and exact-site ownership validation.
      connect();
    }
    this.#connections.delete(store);
    this.#connections.set(store, park);
  }
  #release(store) {
    this.#connections.delete(store);
    if (this.#stores.get(store.siteId) === store) this.#stores.delete(store.siteId);
  }
  site(siteId) {
    this.#checkSite(siteId);
    const cached = this.#stores.get(siteId);
    if (cached && !cached.closed) return cached;
    const store = new SitePerformanceStore(this.directory, siteId,
      (handle, connect, park) => this.#activate(handle, connect, park),
      handle => this.#release(handle));
    this.#stores.set(siteId, store);
    return store;
  }
  hasData(siteId) {
    this.#checkSite(siteId);
    // Inventory must not materialize a database for an unvisited site. lstat,
    // unlike existsSync, also sends broken symlinks through the path guard.
    try {lstatSync(join(this.directory, `${digest(siteId)}.sqlite`));}
    catch (error) {if (error.code === 'ENOENT') return false; throw error;}
    return this.site(siteId).describe().revision > 0;
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear(); this.#connections.clear();
  }
}

class SitePerformanceStore {
  #db;
  #filename;
  #activate;
  #release;
  #activities = 0;
  #closed = false;
  #iterators = new Set();
  #loading = new Map();
  #statements = new Map();
  constructor(directory, siteId, activate, release) {
    this.siteId = siteId;
    this.siteHash = digest(siteId);
    this.#filename = join(directory, `${this.siteHash}.sqlite`);
    const connect = () => this.#connect(), park = () => this.#park();
    this.#activate = () => activate(this, connect, park);
    this.#release = release;
    this.#open();
  }
  #connect() {
    const siteId = this.siteId;
    safeFile(this.#filename);
    this.#db = new DatabaseSync(this.#filename);
    try {
      this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
      // Validate existing objects and ownership before making any schema changes.
      const version = validateSchema(this.#db);
      if (version) ownership(this.#db, siteId, this.siteHash);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA cache_size=-8192; PRAGMA journal_size_limit=16777216;');
      transaction(this.#db, () => {
        const current = validateSchema(this.#db);
        if (current) ownership(this.#db, siteId, this.siteHash);
        else this.#db.exec(LEDGER_SQL);
        for (const migration of MIGRATIONS) {
          if (migration.version <= current) continue;
          this.#db.exec(migration.sql);
          this.#db.prepare('INSERT INTO __performance_migrations VALUES (?,?)').run(migration.version, digest(migration.sql));
          this.#db.exec(`PRAGMA user_version=${migration.version}`);
        }
        if (!current) {
          const createdAt = nowISO();
          const empty = {siteId, revision: 0, revisionId: `${this.siteHash}:0`, timezone: 'UTC', intervalMinutes: 60, timestampStart: null, timestampEnd: null, timestampCount: 0, readingCount: 0, channelCount: 0, createdAt, updatedAt: createdAt};
          this.#db.prepare('INSERT INTO revisions VALUES (?,?,?)').run(0, empty.revisionId, JSON.stringify(empty));
          this.#db.prepare('INSERT INTO site_state VALUES (1,?,?,0)').run(siteId, this.siteHash);
        }
        validateSchema(this.#db);
        ownership(this.#db, siteId, this.siteHash);
      });
      check(this.#db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal' && this.#db.prepare('PRAGMA synchronous').get().synchronous === 2, 'UNSAFE_DATABASE_MODE', 'WAL and FULL synchronous are required.', 500);
      this.#cleanup();
    } catch (error) {
      this.#disconnect();
      if (error.status) throw error;
      throw failure('INCOMPATIBLE_SCHEMA', `Cannot initialize the performance database: ${error.message}`, 500);
    }
  }
  get closed() {return this.#closed;}
  #open() {
    check(!this.#closed, 'STORE_CLOSED', 'Site performance store is closed.', 503);
    this.#activate();
  }
  #using(work) {
    this.#open();
    this.#activities++;
    // Synchronous calls can reenter the manager through caller-owned getters.
    // Keep their transaction/validation connection alive until they return too.
    try {return work();} finally {this.#activities--;}
  }
  #disconnect() {
    this.#db?.close();
    this.#db = undefined;
    this.#statements.clear();
  }
  #park() {
    // A ready, persisted preview needs no live connection. A producer (including
    // its awaited return cleanup) or a reader created before first next() does.
    if (this.#activities || this.#loading.size || this.#iterators.size) return false;
    this.#disconnect();
    return true;
  }
  #stmt(sql) {
    // Only fixed SQL is cached, so callers cannot create an unbounded cache.
    let statement = this.#statements.get(sql);
    if (!statement) {statement = this.#db.prepare(sql); this.#statements.set(sql, statement);}
    return statement;
  }
  #head() {return this.#stmt('SELECT head_revision FROM site_state WHERE singleton=1').get().head_revision;}
  describe(revision) {return this.#using(() => this.#describe(revision));}
  #describe(revision) {
    if (revision === undefined) revision = this.#head();
    check(Number.isSafeInteger(revision) && revision >= 0, 'INVALID_REVISION', 'Revision must be a nonnegative safe integer.');
    const saved = this.#stmt('SELECT dataset_json FROM revisions WHERE revision=?').get(revision);
    check(saved, 'REVISION_NOT_FOUND', 'Requested performance revision does not exist.', 404);
    return JSON.parse(saved.dataset_json);
  }
  #stageRecord(stageId) {
    check(text(stageId, 128), 'INVALID_STAGE_ID', 'Invalid stage ID.');
    const saved = this.#stmt('SELECT * FROM stages WHERE stage_id=?').get(stageId);
    check(saved, 'STAGE_NOT_FOUND', 'Performance import preview not found.', 404);
    return saved;
  }
  #discard(stageId, reason) {
    this.#stmt("UPDATE stages SET status='canceled',canceled_reason=? WHERE stage_id=? AND status IN ('loading','preview')").run(reason, stageId);
    this.#stmt('DELETE FROM staged_readings WHERE stage_id=?').run(stageId);
    this.#stmt('DELETE FROM staged_channels WHERE stage_id=?').run(stageId);
  }
  #cleanup() {
    transaction(this.#db, () => {
      // Never evict an in-process producer. Its next batch will enforce expiry.
      const expired = this.#stmt("SELECT stage_id FROM stages WHERE status IN ('loading','preview') AND expires_at<=?").all(nowISO());
      for (const row of expired) if (!this.#loading.has(row.stage_id)) this.#discard(row.stage_id, 'expired');
      this.#stmt("DELETE FROM stages WHERE status='canceled' AND expires_at<?").run(new Date(Date.now() - CANCELED_RETENTION_MS).toISOString());
      this.#stmt("DELETE FROM stages WHERE status='canceled' AND stage_id NOT IN (SELECT stage_id FROM stages WHERE status='canceled' ORDER BY expires_at DESC,stage_id DESC LIMIT ?)").run(MAX_CANCELED_PREVIEWS);
    });
  }
  #assertLoading(stageId) {
    this.#open();
    const saved = this.#stageRecord(stageId);
    check(saved.status === 'loading', 'STAGE_CANCELED', 'This staged import is no longer accepting readings.', 409);
    check(saved.expires_at > nowISO(), 'STAGE_EXPIRED', 'The staged import has expired; create a new preview.', 410);
    check(saved.base_revision === this.#head(), 'STALE_PREVIEW', 'Site data changed while the import was being staged; create a new preview.', 409);
    return saved;
  }
  #channel(stageId, channel) {
    const canonical = this.#stmt('SELECT * FROM channels WHERE id=?').get(channel.id);
    check(!canonical || sameChannel(canonical, channel), 'CHANNEL_CONFLICT', 'Channel identity, equipment, measurement and unit must match the saved definition.', 409);
    const staged = this.#stmt('SELECT * FROM staged_channels WHERE stage_id=? AND id=?').get(stageId, channel.id);
    check(!staged || sameChannel(staged, channel), 'CHANNEL_CONFLICT', 'Conflicting channel definitions in the import.', 409);
    if (!staged) this.#stmt('INSERT INTO staged_channels VALUES (?,?,?,?,?)').run(stageId, channel.id, channel.equipmentId, channel.measurement, channel.unit);
  }
  #flush(stageId, batch) {
    transaction(this.#db, () => {
      this.#assertLoading(stageId);
      const definitions = new Map();
      for (const reading of batch) {
        const definition = JSON.stringify(reading.channel);
        const previousDefinition = definitions.get(reading.channel.id);
        if (previousDefinition === undefined) {
          this.#channel(stageId, reading.channel);
          definitions.set(reading.channel.id, definition);
        } else check(previousDefinition === definition, 'CHANNEL_CONFLICT', 'Conflicting channel definitions in the import.', 409);
        const inserted = this.#stmt('INSERT INTO staged_readings VALUES (?,?,?,?) ON CONFLICT DO NOTHING').run(stageId, reading.timestamp, reading.channel.id, reading.valueJSON);
        if (!inserted.changes) {
          const previous = this.#stmt('SELECT value_json FROM staged_readings WHERE stage_id=? AND timestamp=? AND channel_id=?').get(stageId, reading.timestamp, reading.channel.id);
          check(previous.value_json === reading.valueJSON, 'CONFLICTING_DUPLICATE', 'The input supplies different values for the same UTC timestamp and channel.', 409);
        }
      }
      check(this.#stmt('SELECT COUNT(*) n FROM staged_channels WHERE stage_id=?').get(stageId).n <= MAX_CHANNELS, 'IMPORT_TOO_LARGE', 'Import exceeds the channel limit.', 413);
    });
  }
  #summarize(saved) {
    const stageId = saved.stage_id;
    const counts = this.#stmt(`SELECT
      COALESCE(SUM(r.channel_id IS NULL),0) AS added,
      COALESCE(SUM(r.channel_id IS NOT NULL),0) AS overlapping,
      COALESCE(SUM(r.channel_id IS NOT NULL AND s.value_json!='null' AND s.value_json!=r.value_json),0) AS changed,
      COALESCE(SUM(r.channel_id IS NOT NULL AND s.value_json=r.value_json),0) AS identical,
      COALESCE(SUM(r.channel_id IS NOT NULL AND s.value_json='null' AND r.value_json!='null'),0) AS blankPreserved
      FROM staged_readings s LEFT JOIN readings r ON r.timestamp=s.timestamp AND r.channel_id=s.channel_id WHERE s.stage_id=?`).get(stageId);
    const range = this.#stmt('SELECT MIN(timestamp) timestampStart,MAX(timestamp) timestampEnd,COUNT(*) readingCount,COUNT(DISTINCT channel_id) channelCount FROM staged_readings WHERE stage_id=?').get(stageId);
    const sampleRows = this.#stmt(`SELECT s.timestamp,s.channel_id,c.equipment_id,c.measurement,c.unit,r.value_json previous,s.value_json incoming
      FROM staged_readings s JOIN readings r ON r.timestamp=s.timestamp AND r.channel_id=s.channel_id
      JOIN staged_channels c ON c.stage_id=s.stage_id AND c.id=s.channel_id WHERE s.stage_id=?
      ORDER BY (s.value_json!='null' AND s.value_json!=r.value_json) DESC,s.timestamp,s.channel_id LIMIT ?`).all(stageId, SAMPLE_LIMIT);
    return {siteId: this.siteId, stageId, previewToken: saved.token, baseRevision: saved.base_revision, status: 'preview', counts: {...counts}, ...range, metadata: JSON.parse(saved.metadata_json), samples: sampleRows.map(row => ({timestamp: row.timestamp, channel: channelFrom(row), previous: JSON.parse(row.previous), incoming: JSON.parse(row.incoming)})), createdAt: saved.created_at, expiresAt: saved.expires_at};
  }
  async stage(inputMetadata, readings, options) {
    this.#open();
    this.#activities++;
    try {return await this.#stage(inputMetadata, readings, options);}
    finally {this.#activities--;}
  }
  async #stage(inputMetadata, readings, options) {
    const expectedRevision = options?.expectedRevision;
    if (options !== undefined) check(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'INVALID_REVISION', 'Expected revision must be a nonnegative safe integer.');
    const metadata = normalizeMetadata(inputMetadata);
    check(readings && (typeof readings[Symbol.asyncIterator] === 'function' || typeof readings[Symbol.iterator] === 'function'), 'INVALID_READINGS', 'Readings must be an iterable or async iterable.');
    this.#cleanup();
    const stageId = randomUUID();
    transaction(this.#db, () => {
      const base = this.describe();
      // Grid validation belongs to this exact revision, not a newer head. Check
      // under the writer lock before allocating a stage or opening the input.
      check(options === undefined || base.revision === expectedRevision, 'STALE_PREVIEW', 'Site data changed while the import was being validated; create a new preview.', 409);
      check(base.revision === 0 || base.intervalMinutes === metadata.intervalMinutes, 'CADENCE_MISMATCH', 'Import cadence must match the saved site cadence.', 409);
      check(this.#stmt("SELECT COUNT(*) n FROM stages WHERE status IN ('loading','preview')").get().n < MAX_ACTIVE_STAGES, 'STAGE_CAPACITY', 'Too many pending imports for this site; commit or cancel a preview first.', 429);
      this.#stmt("INSERT INTO stages(stage_id,token,base_revision,status,metadata_json,created_at,expires_at) VALUES (?,?,?,'loading',?,?,?)").run(stageId, randomBytes(32).toString('hex'), base.revision, JSON.stringify(metadata), nowISO(), new Date(Date.now() + STAGE_TTL_MS).toISOString());
    });
    let iterator;
    let inputFinished = false;
    try {
      iterator = readings[Symbol.asyncIterator]?.() ?? readings[Symbol.iterator]();
      this.#loading.set(stageId, iterator);
      let batch = [], batchBytes = 0, consumed = 0, bytes = 0;
      // Explicit iterator management also closes custom iterators if next() throws.
      while (true) {
        this.#open();
        const step = await iterator.next();
        check(step && typeof step === 'object', 'INVALID_READINGS', 'Input iterator returned an invalid step.');
        if (step.done) {inputFinished = true; break;}
        const reading = normalizeReading(step.value);
        consumed++;
        const readingBytes = Buffer.byteLength(reading.timestamp) + Buffer.byteLength(JSON.stringify(reading.channel)) + Buffer.byteLength(reading.valueJSON);
        bytes += readingBytes; batchBytes += readingBytes;
        check(consumed <= MAX_INPUT_ROWS && bytes <= MAX_INPUT_BYTES, 'IMPORT_TOO_LARGE', 'Import exceeds the reading or byte limit.', 413);
        batch.push(reading);
        if (batch.length === BATCH_SIZE || batchBytes >= BATCH_BYTES) {this.#flush(stageId, batch); batch = []; batchBytes = 0; await yieldToEventLoop();}
      }
      if (batch.length) this.#flush(stageId, batch);
      check(consumed > 0, 'EMPTY_IMPORT', 'The import contains no readings.');
      return transaction(this.#db, () => {
        const saved = this.#assertLoading(stageId);
        const preview = this.#summarize(saved);
        this.#stmt("UPDATE stages SET status='preview',preview_json=? WHERE stage_id=?").run(JSON.stringify(preview), stageId);
        return preview;
      });
    } catch (error) {
      if (!this.#closed) transaction(this.#db, () => this.#discard(stageId, error.code === 'STAGE_EXPIRED' ? 'expired' : 'failed'));
      throw error;
    } finally {
      this.#loading.delete(stageId);
      if (!inputFinished && iterator?.return) {try {await iterator.return();} catch { /* Preserve the original ingestion error. */ }}
    }
  }
  #publicPreview(saved) {
    check(saved.preview_json, 'STAGE_NOT_READY', 'This import has not produced a preview.', 409);
    const preview = JSON.parse(saved.preview_json);
    preview.status = saved.status;
    if (saved.result_json) preview.result = JSON.parse(saved.result_json);
    return preview;
  }
  preview(stageId) {return this.#using(() => this.#preview(stageId));}
  #preview(stageId) {
    this.#cleanup();
    return this.#publicPreview(this.#stageRecord(stageId));
  }
  commit(stageId, options) {return this.#using(() => this.#commit(stageId, options));}
  #commit(stageId, options) {
    this.#cleanup();
    return transaction(this.#db, () => {
      const saved = this.#stageRecord(stageId);
      const token = options?.previewToken;
      check(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(saved.token)), 'INVALID_PREVIEW_TOKEN', 'The preview token does not match this staged import.', 409);
      // The stage ID is the idempotency key. A successful replay returns the exact
      // original result even if model/head/actor/expiry have since changed.
      if (saved.status === 'committed') return JSON.parse(saved.result_json);
      check(saved.canceled_reason !== 'expired' && saved.expires_at > nowISO(), 'STAGE_EXPIRED', 'This preview has expired; create a new preview.', 410);
      check(saved.status !== 'canceled', 'STAGE_CANCELED', 'This import was canceled.', 409);
      check(saved.status === 'preview', 'STAGE_NOT_READY', 'Import is still being staged.', 409);
      const preview = this.#publicPreview(saved);
      check(saved.base_revision === this.#head(), 'STALE_PREVIEW', 'Site data changed after this preview; create a new preview.', 409);
      check(options.modelRevision === preview.metadata.modelRevision, 'MODEL_REVISION_CHANGED', 'The site model changed after this preview; create a new preview.', 409);
      check(preview.counts.overlapping === 0 || options.approveOverlap === true, 'OVERLAP_APPROVAL_REQUIRED', 'Every overlap requires explicit approval, including identical readings.', 409);
      check(text(options.actor), 'INVALID_ACTOR', 'An import approval actor is required.');
      const before = this.describe(saved.base_revision);
      check(before.revision === 0 || before.intervalMinutes === preview.metadata.intervalMinutes, 'CADENCE_MISMATCH', 'Import cadence no longer matches the site.', 409);
      const revision = before.revision + 1;
      check(Number.isSafeInteger(revision), 'REVISION_LIMIT', 'Revision counter exhausted.', 507);
      const committedAt = nowISO();
      const result = {siteId: this.siteId, stageId, revision, revisionId: `${this.siteHash}:${revision}`, committedAt, counts: preview.counts};
      // A placeholder snapshot satisfies the foreign keys while the complete
      // summary is assembled in this same synchronous, atomic site transaction.
      this.#stmt('INSERT INTO revisions VALUES (?,?,?)').run(revision, result.revisionId, '{}');
      const conflict = this.#stmt(`SELECT 1 FROM staged_channels s JOIN channels c ON c.id=s.id
        WHERE s.stage_id=? AND (c.equipment_id!=s.equipment_id OR c.measurement!=s.measurement OR c.unit!=s.unit) LIMIT 1`).get(stageId);
      check(!conflict, 'CHANNEL_CONFLICT', 'A canonical channel definition conflicts with the import.', 409);
      this.#stmt('INSERT INTO channels SELECT id,equipment_id,measurement,unit FROM staged_channels WHERE stage_id=? ON CONFLICT DO NOTHING').run(stageId);
      // Record incoming, previous (SQL NULL means absent), and effective after
      // values for every supplied key, including approved identical/null overlaps.
      this.#stmt(`INSERT INTO reading_versions(timestamp,channel_id,revision,value_json,previous_value_json,incoming_value_json)
        SELECT s.timestamp,s.channel_id,?,CASE WHEN s.value_json='null' AND r.channel_id IS NOT NULL THEN r.value_json ELSE s.value_json END,r.value_json,s.value_json
        FROM staged_readings s LEFT JOIN readings r ON r.timestamp=s.timestamp AND r.channel_id=s.channel_id WHERE s.stage_id=?`).run(revision, stageId);
      this.#stmt(`INSERT INTO readings(timestamp,channel_id,value_json,revision)
        SELECT timestamp,channel_id,value_json,revision FROM reading_versions WHERE revision=?
        ON CONFLICT(timestamp,channel_id) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision`).run(revision);
      const totals = this.#stmt('SELECT MIN(timestamp) timestampStart,MAX(timestamp) timestampEnd,COUNT(DISTINCT timestamp) timestampCount,COUNT(*) readingCount,COUNT(DISTINCT channel_id) channelCount FROM readings').get();
      const dataset = {...before, revision, revisionId: result.revisionId, timezone: before.revision === 0 ? preview.metadata.timezone : before.timezone, intervalMinutes: preview.metadata.intervalMinutes, ...totals, updatedAt: committedAt};
      this.#stmt('UPDATE revisions SET dataset_json=? WHERE revision=?').run(JSON.stringify(dataset), revision);
      this.#stmt('INSERT INTO imports VALUES (?,?,?,?,?,?)').run(stageId, revision, JSON.stringify(result), saved.metadata_json, options.actor, options.approveOverlap === true ? 1 : 0);
      this.#stmt('UPDATE site_state SET head_revision=? WHERE singleton=1').run(revision);
      this.#stmt("UPDATE stages SET status='committed',result_json=? WHERE stage_id=?").run(JSON.stringify(result), stageId);
      this.#stmt('DELETE FROM staged_readings WHERE stage_id=?').run(stageId);
      this.#stmt('DELETE FROM staged_channels WHERE stage_id=?').run(stageId);
      return result;
    });
  }
  cancel(stageId) {return this.#using(() => this.#cancel(stageId));}
  #cancel(stageId) {
    this.#cleanup();
    return transaction(this.#db, () => {
      const saved = this.#stageRecord(stageId);
      if (saved.status !== 'committed') this.#discard(stageId, saved.canceled_reason ?? 'canceled');
      return this.#publicPreview(this.#stageRecord(stageId));
    });
  }
  rows(revision, scope) {return this.#using(() => this.#rows(revision, scope));}
  // Reporting only: effective-value provenance survives null-preserving imports.
  // Never substitute the latest import or numeric fingerprint for this owner.
  reportingRows(revision, scope) {return this.#using(() => this.#rows(revision, scope, true));}
  #rows(revision, scope, reporting = false) {
    // Resolve the default revision NOW, not when a lazy generator is first read.
    const pinned = this.describe(revision).revision;
    const filter = scopeFilter(scope);
    check(this.#iterators.size < MAX_ITERATORS, 'ITERATOR_CAPACITY', 'Too many active performance iterators; close unused iterators.', 429);
    const store = this;
    let iterator;
    function* read() {
      let lastTimestamp = '', lastChannel = '';
      try {
        while (true) {
          store.#open();
          // Keyset pages over immutable history avoid both a mutable-head snapshot
          // and a long-lived SQLite read transaction that would pin WAL retention.
          const page = store.#db.prepare(`SELECT v.timestamp,v.channel_id,v.value_json,c.equipment_id,c.measurement,c.unit
            ${reporting ? ',i.revision owner_revision,i.stage_id owner_stage,i.metadata_json owner_metadata' : ''}
            FROM reading_versions v JOIN channels c ON c.id=v.channel_id
            ${reporting ? `JOIN imports i ON i.revision=(SELECT MAX(o.revision) FROM reading_versions o
              WHERE o.timestamp=v.timestamp AND o.channel_id=v.channel_id AND o.revision<=v.revision
              AND (o.incoming_value_json!='null' OR o.previous_value_json IS NULL))` : ''}
            WHERE (v.timestamp,v.channel_id)>(?,?) AND v.revision<=?
              AND v.revision=(SELECT MAX(h.revision) FROM reading_versions h WHERE h.timestamp=v.timestamp AND h.channel_id=v.channel_id AND h.revision<=?)
              ${filter.sql} ORDER BY v.timestamp,v.channel_id LIMIT ?`).all(lastTimestamp, lastChannel, pinned, pinned, ...filter.params, BATCH_SIZE);
          if (!page.length) return;
          for (const row of page) yield {timestamp: row.timestamp, channel: channelFrom(row), value: JSON.parse(row.value_json), ...(reporting ? {owner:{revision:row.owner_revision,stageId:row.owner_stage,metadata:JSON.parse(row.owner_metadata)}} : {})};
          lastTimestamp = page.at(-1).timestamp; lastChannel = page.at(-1).channel_id;
          if (page.length < BATCH_SIZE) return;
        }
      } finally {store.#iterators.delete(iterator);}
    }
    const generator = read();
    // A never-started generator does not execute finally on return(). Explicitly
    // release tracking for that case too, and close it on a consumer exception.
    iterator = {
      next(value) {return generator.next(value);},
      return(value) {try {return generator.return(value);} finally {store.#iterators.delete(iterator);}},
      throw(error) {try {return generator.throw(error);} finally {store.#iterators.delete(iterator);}},
      [Symbol.iterator]() {return this;},
    };
    this.#iterators.add(iterator);
    return iterator;
  }
  fingerprint(revision, scope) {
    const hash = createHash('sha256').update('sol-performance-semantic-v1\n');
    for (const row of this.rows(revision, scope)) hash.update(JSON.stringify([row.timestamp, row.channel.id, row.channel.equipmentId, row.channel.measurement, row.channel.unit, row.value]) + '\n');
    return hash.digest('hex');
  }
  imports(limit = 100) {return this.#using(() => this.#imports(limit));}
  #imports(limit) {
    check(Number.isSafeInteger(limit) && limit >= 0 && limit <= 1000, 'INVALID_LIMIT', 'Import audit limit must be between 0 and 1000.');
    return this.#stmt('SELECT * FROM imports ORDER BY revision DESC LIMIT ?').all(limit).map(row => ({...JSON.parse(row.result_json), metadata: JSON.parse(row.metadata_json), actor: row.actor, overlapApproved: row.overlap_approved === 1}));
  }
  recordAnalysis(runId, provenance) {return this.#using(() => this.#recordAnalysis(runId, provenance));}
  #recordAnalysis(runId, provenance) {
    check(text(runId), 'INVALID_RUN_ID', 'An analysis run ID is required.');
    check(provenance && provenance.version === 1 && provenance.siteId === this.siteId && provenance.dependencyScope === 'analysis-range' && Number.isSafeInteger(provenance.revision) && provenance.revision >= 0 && Array.isArray(provenance.scopes) && Array.isArray(provenance.hashes) && provenance.scopes.length === provenance.hashes.length && provenance.scopes.length <= 100, 'INVALID_PROVENANCE', 'Invalid or cross-site analysis provenance.');
    const dataset = this.describe(provenance.revision);
    check(provenance.revisionId === dataset.revisionId, 'INVALID_PROVENANCE', 'Analysis revision identity does not match the saved site revision.');
    const scopes = Array.from(provenance.scopes, scope => {
      check(scope && typeof scope === 'object' && !Array.isArray(scope), 'INVALID_PROVENANCE', 'Each provenance scope must be an input-scope object.');
      scopeFilter(scope);
      // Retain precisely the contract fields and detach all caller-owned arrays.
      return {start: scope.start, end: scope.end, ...(scope.equipmentIds !== undefined ? {equipmentIds: [...scope.equipmentIds]} : {}), ...(scope.measurements !== undefined ? {measurements: [...scope.measurements]} : {})};
    });
    check(Array.from(provenance.hashes).every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)), 'INVALID_PROVENANCE', 'Analysis input hashes must be SHA-256 hex strings.');
    const json = canonicalJSON({version: 1, siteId: provenance.siteId, revision: provenance.revision, revisionId: provenance.revisionId, scopes, hashes: [...provenance.hashes], dependencyScope: 'analysis-range'});
    check(Buffer.byteLength(json) <= 1024 * 1024, 'INVALID_PROVENANCE', 'Analysis provenance is too large.');
    transaction(this.#db, () => {
      const existing = this.#stmt('SELECT provenance_json FROM analyses WHERE run_id=?').get(runId);
      if (existing) {
        check(existing.provenance_json === json, 'ANALYSIS_CONFLICT', 'Saved analysis provenance is immutable.', 409);
        return;
      }
      this.#stmt('INSERT INTO analyses VALUES (?,?,?)').run(runId, provenance.revision, json);
    });
  }
  analysis(runId) {return this.#using(() => this.#analysis(runId));}
  #analysis(runId) {
    check(text(runId), 'INVALID_RUN_ID', 'An analysis run ID is required.');
    const saved = this.#stmt('SELECT provenance_json FROM analyses WHERE run_id=?').get(runId);
    return saved ? JSON.parse(saved.provenance_json) : null;
  }
  close() {
    if (this.#closed) return;
    for (const iterator of this.#iterators) iterator.return();
    if (this.#loading.size) transaction(this.#db, () => {for (const stageId of this.#loading.keys()) this.#discard(stageId, 'closed');});
    this.#closed = true;
    for (const iterator of this.#loading.values()) {
      try {Promise.resolve(iterator?.return?.()).catch(() => {});} catch {}
    }
    this.#loading.clear(); this.#disconnect(); this.#release(this);
  }
}
