import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import 'dotenv/config';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function envPath(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function configDir(): string {
  return path.resolve(PROJECT_ROOT, envPath('JOB_RADAR_CONFIG_DIR', 'config'));
}

function readYaml(file: string): unknown {
  const full = path.resolve(configDir(), file);
  if (!existsSync(full)) throw new Error(`Missing configuration file: ${full}`);
  return parseYaml(readFileSync(full, 'utf8'));
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, file: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration in ${file}:\n${issues}`);
  }
  return result.data;
}

/* ------------------------------------------------------------------ profile */

const skillSchema = z.object({
  name: z.string().min(1),
  proficiency: z.enum(['expert', 'strong', 'working', 'basic']),
  aliases: z.array(z.string()).optional(),
  note: z.string().optional(),
});

export const profileSchema = z.object({
  version: z.string().min(1),
  identity: z.object({
    name: z.string(),
    alias: z.string().optional(),
    headline: z.string(),
    years_of_sap_experience: z.number(),
    base_location: z.string(),
    timezone: z.string().optional(),
  }),
  availability: z.record(z.string(), z.unknown()).optional(),
  work_authorization: z.record(z.string(), z.unknown()).optional(),
  travel: z.record(z.string(), z.unknown()).optional(),
  engagement: z.object({
    preferred_types: z.array(z.string()),
    acceptable_types: z.array(z.string()),
    rejected_types: z.array(z.string()),
    preferred_work_mode: z.string(),
    acceptable_work_modes: z.array(z.string()),
    preferred_regions: z.array(z.string()),
  }),
  compensation: z.object({
    target_hourly_rate: z.number(),
    minimum_hourly_rate: z.number(),
    currency: z.string(),
    hours_per_day: z.number(),
    working_days_per_month: z.number(),
    working_months_per_year: z.number(),
  }),
  languages: z.array(z.object({ code: z.string(), proficiency: z.string() })),
  skills: z.record(z.string(), z.array(skillSchema)),
  not_claimed: z.array(z.string()).default([]),
  not_claimed_aliases: z.record(z.string(), z.array(z.string())).default({}),
});
export type Profile = z.infer<typeof profileSchema>;

/* ----------------------------------------------------------------- searches */

const geoSchema = z.object({
  id: z.string(),
  location: z.string().optional(),
  country_indeed: z.string().optional(),
});

const sourceSchema = z.object({
  enabled: z.boolean(),
  geos: z.record(z.string(), geoSchema),
  results_wanted: z.number().int().positive(),
  delay_between_tasks_seconds: z.number().nonnegative().default(0),
  task_timeout_seconds: z.number().int().positive(),
  supports_description_fetch: z.boolean().default(false),
  search_results_include_description: z.boolean().default(false),
});

export const searchesSchema = z.object({
  defaults: z.object({
    hours_old: z.number().int().positive(),
    results_wanted: z.number().int().positive(),
    description_format: z.enum(['markdown', 'html']),
    distance: z.number().int().positive(),
    job_type: z.string().nullable().default(null),
    is_remote: z.boolean().default(false),
  }),
  keywords: z.array(z.string().min(1)).min(1),
  sources: z.record(z.string(), sourceSchema),
  rotation: z.object({
    interval_hours: z.number().positive(),
    batches: z
      .array(
        z.object({
          key: z.string(),
          keywords: z.array(z.string()).min(1),
          targets: z.record(z.string(), z.array(z.string())),
        }),
      )
      .min(1),
  }),
  description_budget: z.object({
    max_tasks_per_run: z.number().int().nonnegative(),
    prefer_sources: z.array(z.string()).default([]),
  }),
  resilience: z.object({
    max_tasks_per_run: z.number().int().positive(),
    max_retries_per_task: z.number().int().nonnegative(),
    retry_delay_seconds: z.number().nonnegative(),
    failure_threshold: z.number().int().positive(),
    cooldown_minutes: z.record(z.string(), z.number().nonnegative()),
    process_timeout_seconds: z.number().int().positive(),
  }),
});
export type Searches = z.infer<typeof searchesSchema>;
export type SourceConfig = z.infer<typeof sourceSchema>;

/* ------------------------------------------------------------------ scoring */

const hardRejectRuleSchema = z.object({
  id: z.string(),
  reason: z.string(),
  any: z.array(z.string()).min(1),
  none: z.array(z.string()).default([]),
});

export const scoringSchema = z.object({
  version: z.string(),
  weights: z.object({
    technical: z.number(),
    commercial: z.number(),
    location: z.number(),
  }),
  thresholds: z.object({
    apply: z.number(),
    review: z.number(),
    notify: z.number(),
    llm_screen_gate: z.number(),
  }),
  uncertainty: z.object({
    neutral_score: z.number(),
    cap_without_description: z.number(),
    require_description_for_llm: z.boolean(),
  }),
  technical: z.object({
    groups: z.record(z.string(), z.object({ points_per_hit: z.number(), cap: z.number() })),
    title_multiplier: z.number(),
    relevant_title_floor: z.number(),
    max: z.number(),
  }),
  commercial: z.object({
    contract_signals_bonus: z.number(),
    permanent_signals_penalty: z.number(),
    rate_at_or_above_target_bonus: z.number(),
    rate_below_minimum_penalty: z.number(),
    base: z.number(),
    max: z.number(),
  }),
  location: z.object({
    base: z.number(),
    fully_remote_bonus: z.number(),
    remote_within_europe_bonus: z.number(),
    hybrid_penalty: z.number(),
    onsite_penalty: z.number(),
    outside_preferred_region_penalty: z.number(),
    preferred_country_bonus: z.number(),
    max: z.number(),
  }),
  hard_rejects: z.object({
    score_cap: z.number(),
    rules: z.array(hardRejectRuleSchema),
  }),
  prescreen: z.object({
    require_any: z.array(z.string()),
    drop_title_terms: z.array(z.string()),
    rescue_terms: z.array(z.string()),
  }),
  signals: z.record(z.string(), z.array(z.string())),
  preferred_countries: z.array(z.string()),
});
export type Scoring = z.infer<typeof scoringSchema>;

/* -------------------------------------------------------------- cv variants */

export const cvVariantsSchema = z.object({
  default: z.string(),
  variants: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        file: z.string().optional(),
        focus: z.array(z.string()).min(1),
      }),
    )
    .min(1),
});
export type CvVariants = z.infer<typeof cvVariantsSchema>;

/* ----------------------------------------------------------------- settings */

export const settingsSchema = z.object({
  storage: z.object({ db_dir: z.string(), db_file: z.string() }),
  collector: z.object({ python: z.string(), script: z.string() }),
  llm: z.object({
    enabled: z.boolean(),
    model: z.string(),
    base_url: z.string().url(),
    temperature: z.number(),
    max_output_tokens: z.number().int().positive(),
    request_timeout_seconds: z.number().int().positive(),
    max_jobs_per_run: z.number().int().nonnegative(),
    max_description_chars: z.number().int().positive(),
  }),
  telegram: z.object({
    enabled: z.boolean(),
    min_fit_score: z.number(),
    max_per_run: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    retry_base_delay_seconds: z.number().nonnegative(),
    disable_web_page_preview: z.boolean(),
  }),
  scheduler: z.object({
    cron: z.string(),
    timezone: z.string(),
    run_on_start: z.boolean(),
  }),
});
export type Settings = z.infer<typeof settingsSchema>;

/* --------------------------------------------------------------------- env */

export interface Secrets {
  openaiApiKey: string | undefined;
  openaiModel: string | undefined;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
}

export interface AppConfig {
  profile: Profile;
  searches: Searches;
  scoring: Scoring;
  cvVariants: CvVariants;
  settings: Settings;
  secrets: Secrets;
  dbPath: string;
  pythonPath: string;
  collectorScript: string;
  llmAvailable: boolean;
  telegramAvailable: boolean;
}

let cached: AppConfig | undefined;

export function loadConfig(options: { reload?: boolean } = {}): AppConfig {
  if (cached && !options.reload) return cached;

  const profile = parseOrThrow(profileSchema, readYaml('profile.yaml'), 'profile.yaml');
  const searches = parseOrThrow(searchesSchema, readYaml('searches.yaml'), 'searches.yaml');
  const scoring = parseOrThrow(scoringSchema, readYaml('scoring.yaml'), 'scoring.yaml');
  const cvVariants = parseOrThrow(cvVariantsSchema, readYaml('cv-variants.yaml'), 'cv-variants.yaml');
  const settings = parseOrThrow(settingsSchema, readYaml('settings.yaml'), 'settings.yaml');

  const weightSum = scoring.weights.technical + scoring.weights.commercial + scoring.weights.location;
  if (Math.abs(weightSum - 1) > 1e-6) {
    throw new Error(`scoring.yaml: weights must sum to 1.0 but sum to ${weightSum}`);
  }
  if (!cvVariants.variants.some((variant) => variant.id === cvVariants.default)) {
    throw new Error(`cv-variants.yaml: default "${cvVariants.default}" is not a configured variant`);
  }
  for (const batch of searches.rotation.batches) {
    for (const [source, geoIds] of Object.entries(batch.targets)) {
      const sourceConfig = searches.sources[source];
      if (!sourceConfig) throw new Error(`searches.yaml: batch "${batch.key}" targets unknown source "${source}"`);
      for (const geoId of geoIds) {
        if (!sourceConfig.geos[geoId]) {
          throw new Error(`searches.yaml: batch "${batch.key}" targets unknown geo "${geoId}" for source "${source}"`);
        }
      }
    }
  }

  const dbDir = path.resolve(PROJECT_ROOT, envPath('JOB_RADAR_DB_DIR', settings.storage.db_dir));
  const secrets: Secrets = {
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    openaiModel: process.env.OPENAI_MODEL?.trim() || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || undefined,
  };
  if (secrets.openaiModel) settings.llm.model = secrets.openaiModel;

  cached = {
    profile,
    searches,
    scoring,
    cvVariants,
    settings,
    secrets,
    dbPath: path.join(dbDir, settings.storage.db_file),
    pythonPath: path.resolve(PROJECT_ROOT, envPath('JOB_RADAR_PYTHON', settings.collector.python)),
    collectorScript: path.resolve(
      PROJECT_ROOT,
      envPath('JOB_RADAR_COLLECTOR_SCRIPT', settings.collector.script),
    ),
    llmAvailable: settings.llm.enabled && Boolean(secrets.openaiApiKey),
    telegramAvailable:
      settings.telegram.enabled && Boolean(secrets.telegramBotToken) && Boolean(secrets.telegramChatId),
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
