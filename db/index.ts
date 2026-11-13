import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { getDatabaseBinding } from "./binding";

export function getDb() {
  return drizzle(getDatabaseBinding(), { schema });
}
