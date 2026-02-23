import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

function getConnectionConfig(): pg.PoolConfig {
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl && (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://'))) {
    const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1') || dbUrl.includes('host=/tmp');
    return {
      connectionString: dbUrl,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    };
  }

  const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
  const isRemoteDisabled = PGHOST && PGHOST.includes('neon.tech');

  if (!isRemoteDisabled && PGHOST && PGUSER && PGDATABASE) {
    const isLocalHost = PGHOST === 'localhost' || PGHOST === '127.0.0.1';
    return {
      host: PGHOST,
      port: parseInt(PGPORT || '5432', 10),
      user: PGUSER,
      password: PGPASSWORD || undefined,
      database: PGDATABASE,
      ssl: isLocalHost ? false : { rejectUnauthorized: false },
    };
  }

  console.log("[db] Using local PostgreSQL via Unix socket");
  return {
    host: '/tmp',
    port: 5432,
    user: 'runner',
    database: 'neondb',
    ssl: false,
  };
}

export const pool = new Pool(getConnectionConfig());
export const db = drizzle(pool, { schema });
