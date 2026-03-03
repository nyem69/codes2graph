import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

export interface Config {
  neo4jUri: string;
  neo4jUsername: string;
  neo4jPassword: string;
  indexSource: boolean;
  skipExternal: boolean;
}

export function loadConfig(): Config {
  // Load from ~/.codegraphcontext/.env (CGC's config location)
  const cgcEnvPath = resolve(process.env.HOME || '~', '.codegraphcontext', '.env');
  if (existsSync(cgcEnvPath)) {
    dotenvConfig({ path: cgcEnvPath });
  }
  // Also load local .env (higher priority — dotenv won't overwrite existing)
  dotenvConfig();

  return {
    neo4jUri: process.env.NEO4J_URI || 'bolt://localhost:7687',
    neo4jUsername: process.env.NEO4J_USERNAME || 'neo4j',
    neo4jPassword: process.env.NEO4J_PASSWORD || 'password',
    indexSource: (process.env.INDEX_SOURCE || 'false').toLowerCase() === 'true',
    skipExternal: (process.env.SKIP_EXTERNAL_RESOLUTION || 'false').toLowerCase() === 'true',
  };
}
