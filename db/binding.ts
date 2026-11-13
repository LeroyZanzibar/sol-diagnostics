let database: D1Database | null = null;
let bucket: R2Bucket | null = null;
import {drainPerformanceFileCleanup} from './single-performance-file';
const local=(globalThis as any)[Symbol.for('sol-diagnostics.runtime')];
if(local){database=local.database;bucket=local.bucket;local.cleanup=()=>drainPerformanceFileCleanup(local.database,local.bucket);}

export function setDatabaseBinding(binding: D1Database) {
  database = binding;
}

export function getDatabaseBinding() {
  if (!database) throw new Error("The site database is not available for this request.");
  return database;
}

export function setBucketBinding(binding: R2Bucket) {
  bucket = binding;
}

export function getBucketBinding() {
  if (!bucket) throw new Error("File storage is not available for this request.");
  return bucket;
}
