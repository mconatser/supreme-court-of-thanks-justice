// npm run migrate: create data/court.db with the current schema (safe to run again).
import { join } from "node:path";
import { openDb } from "./db.ts";

const dir = process.env.DATA_DIR || "data";
const path = join(dir, "court.db");
openDb(path).close();
console.log(`court.db is ready at ${path}`);
