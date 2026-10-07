import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configDir, loadConfig, PROJECT_ROOT, resetConfigCache } from '../src/config/index.js';

const pathVariables = ['JOB_RADAR_CONFIG_DIR', 'JOB_RADAR_DB_DIR', 'JOB_RADAR_PYTHON', 'JOB_RADAR_COLLECTOR_SCRIPT'];
const temporaryDirectories: string[] = [];

beforeEach(() => {
  for (const variable of pathVariables) vi.stubEnv(variable, undefined);
  resetConfigCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetConfigCache();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('optional environment paths', () => {
  it.each([undefined, '', ' \t '])('uses configured defaults for absent or blank overrides: %j', (value) => {
    for (const variable of pathVariables) vi.stubEnv(variable, value);
    const config = loadConfig();
    expect(configDir()).toBe(path.join(PROJECT_ROOT, 'config'));
    expect(config.dbPath).toBe(path.join(PROJECT_ROOT, 'data', 'job-radar.sqlite'));
    expect(config.pythonPath).toBe(path.resolve(PROJECT_ROOT, config.settings.collector.python));
    expect(config.collectorScript).toBe(path.resolve(PROJECT_ROOT, config.settings.collector.script));
  });

  it('loads the defaults with the unedited example environment file', () => {
    const example = parseEnv(readFileSync(path.join(PROJECT_ROOT, '.env.example')));
    for (const [variable, value] of Object.entries(example)) vi.stubEnv(variable, value);
    const config = loadConfig();
    expect(configDir()).toBe(path.join(PROJECT_ROOT, 'config'));
    expect(config.dbPath).toBe(path.join(PROJECT_ROOT, 'data', 'job-radar.sqlite'));
    expect(config.pythonPath).toBe(path.resolve(PROJECT_ROOT, config.settings.collector.python));
    expect(config.collectorScript).toBe(path.resolve(PROJECT_ROOT, config.settings.collector.script));
    expect(config.llmAvailable).toBe(false);
    expect(config.telegramAvailable).toBe(false);
  });

  function customConfigDirectory(): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'job-radar-config-'));
    temporaryDirectories.push(directory);
    cpSync(path.join(PROJECT_ROOT, 'config'), directory, { recursive: true });
    return directory;
  }

  it('trims nonempty overrides before resolving them', () => {
    const directory = customConfigDirectory();
    vi.stubEnv('JOB_RADAR_CONFIG_DIR', ` ${directory} `);
    vi.stubEnv('JOB_RADAR_DB_DIR', ' custom/data ');
    vi.stubEnv('JOB_RADAR_PYTHON', ' custom/bin/python ');
    vi.stubEnv('JOB_RADAR_COLLECTOR_SCRIPT', ' custom/collector.py ');
    const config = loadConfig();
    expect(configDir()).toBe(directory);
    expect(config.dbPath).toBe(path.join(PROJECT_ROOT, 'custom/data', config.settings.storage.db_file));
    expect(config.pythonPath).toBe(path.join(PROJECT_ROOT, 'custom/bin/python'));
    expect(config.collectorScript).toBe(path.join(PROJECT_ROOT, 'custom/collector.py'));
  });

  it('falls back to edited YAML settings rather than hard-coded interpreter or storage paths', () => {
    const directory = customConfigDirectory();
    const settingsPath = path.join(directory, 'settings.yaml');
    const settings = parseYaml(readFileSync(settingsPath, 'utf8'));
    settings.storage.db_dir = './custom-store';
    settings.collector.python = './custom-venv/bin/python';
    settings.collector.script = './custom-collector.py';
    writeFileSync(settingsPath, stringifyYaml(settings));
    vi.stubEnv('JOB_RADAR_CONFIG_DIR', directory);
    for (const variable of pathVariables.slice(1)) vi.stubEnv(variable, ' ');
    const config = loadConfig();
    expect(config.dbPath).toBe(path.join(PROJECT_ROOT, 'custom-store', config.settings.storage.db_file));
    expect(config.pythonPath).toBe(path.join(PROJECT_ROOT, 'custom-venv/bin/python'));
    expect(config.collectorScript).toBe(path.join(PROJECT_ROOT, 'custom-collector.py'));
  });
});
