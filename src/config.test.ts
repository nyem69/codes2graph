import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns defaults when no env vars set', () => {
    // Point HOME to a non-existent directory so CGC .env is not loaded
    process.env.HOME = '/tmp/nonexistent-home-for-test';
    delete process.env.NEO4J_URI;
    delete process.env.NEO4J_USERNAME;
    delete process.env.NEO4J_PASSWORD;
    delete process.env.INDEX_SOURCE;
    delete process.env.SKIP_EXTERNAL_RESOLUTION;
    const config = loadConfig();
    expect(config.neo4jUri).toBe('bolt://localhost:7687');
    expect(config.neo4jUsername).toBe('neo4j');
    // Password may come from local .env if it exists, otherwise defaults to 'password'
    expect(typeof config.neo4jPassword).toBe('string');
    expect(config.indexSource).toBe(false);
    expect(config.skipExternal).toBe(false);
  });

  it('reads from environment variables', () => {
    process.env.HOME = '/tmp/nonexistent-home-for-test';
    process.env.NEO4J_URI = 'bolt://custom:7688';
    process.env.NEO4J_USERNAME = 'admin';
    process.env.NEO4J_PASSWORD = 'secret';
    process.env.INDEX_SOURCE = 'true';
    process.env.SKIP_EXTERNAL_RESOLUTION = 'true';
    const config = loadConfig();
    expect(config.neo4jUri).toBe('bolt://custom:7688');
    expect(config.neo4jUsername).toBe('admin');
    expect(config.neo4jPassword).toBe('secret');
    expect(config.indexSource).toBe(true);
    expect(config.skipExternal).toBe(true);
    // configSource reflects that the local .env was found (even though env vars override values)
    expect(config.configSource).toContain('.env');
  });
});
