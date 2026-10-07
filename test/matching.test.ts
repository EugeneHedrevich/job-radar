import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { assessWithRules, prescreen, suggestCvVariant } from '../src/matching/rules.js';
import { detectWorkMode, jobText, onsiteDaysPerMonth, requirementKind } from '../src/matching/signals.js';
import type { MatchableJob } from '../src/matching/types.js';

const config = loadConfig();

function job(overrides: Partial<MatchableJob> = {}): MatchableJob {
  return {
    ID: 'test',
    title: 'Senior SAP BTP Developer',
    company: 'Northwind Cloud Consulting GmbH',
    location: 'Remote, Germany, DE',
    locationCountry: 'Germany',
    isRemote: true,
    jobType: 'contract',
    salaryMin: 60,
    salaryMax: 75,
    salaryInterval: 'hourly',
    salaryCurrency: 'EUR',
    description:
      'Freelance engagement, fully remote within the EU. Build CAP services with Node.js, TypeScript and CDS, expose OData V4, deploy to Cloud Foundry with XSUAA. Must have: CAP, Node.js, SAP HANA Cloud. Nice to have: SAPUI5, Integration Suite. English speaking team.',
    descriptionHash: 'hash',
    primaryUrl: 'https://example.com/job',
    datePosted: '2026-10-04',
    ...overrides,
  };
}

describe('deterministic matching (no LLM key required)', () => {
  it('scores a strong, remote, contract BTP role highly and recommends Apply', () => {
    const result = assessWithRules(config, job());
    expect(result.engine).toBe('rules');
    expect(result.model).toBeNull();
    expect(result.fitScore).toBeGreaterThanOrEqual(config.scoring.thresholds.apply);
    expect(result.recommendation).toBe('Apply');
    expect(result.strongMatches).toContain('CAP');
    expect(result.hardReject).toBe(false);
  });

  it('is deterministic: the same input always produces the same score', () => {
    expect(assessWithRules(config, job()).fitScore).toBe(assessWithRules(config, job()).fitScore);
  });
});

describe('mandatory-gap filtering', () => {
  it.each([
    'Requirements:\n- ABAP OO development is mandatory\n- SAPUI5 is preferred',
    'Mandatory requirements:\n- ABAP OO development\nPreferred skills:\n- SAPUI5',
    'Must have: ABAP OO development, CAP, Node.js. Nice to have: SAPUI5.',
    'Must have CAP, Node.js, ABAP OO development. Nice to have SAPUI5.',
    'Must have CAP, Node.js, ABAP OO development, nice to have SAPUI5.',
    'ABAP OO development is mandatory; SAPUI5 is preferred.',
    'Mandatory: ABAP OO development, preferred: SAPUI5.',
    '<ul><li>ABAP OO development is mandatory</li><li>SAPUI5 is preferred</li></ul>',
  ])('keeps a mandatory skill separate from a preferred skill: %s', (requirements) => {
    const vacancy = job({ description: `${job().description}\n${requirements}` });
    const text = jobText(vacancy);
    expect(requirementKind(config, text.all, 'ABAP OO development')).toBe('mandatory');
    expect(requirementKind(config, text.all, 'SAPUI5')).toBe('preferred');
    const result = assessWithRules(config, vacancy);
    expect(result.mandatoryGaps.join(' ')).toMatch(/ABAP OO/);
    expect(result.preferredGaps.join(' ')).not.toMatch(/ABAP OO/);
    expect(result.recommendation).toBe('Review');
  });

  it('keeps the strongest requirement when the same skill appears as both preferred and mandatory', () => {
    const text = jobText(job({ description: 'ABAP OO development is preferred.\nABAP OO development is mandatory for the client project.' }));
    expect(requirementKind(config, text.all, 'ABAP OO development')).toBe('mandatory');
  });

  it('recognizes short skill names in requirements lists without changing the capability claim', () => {
    const result = assessWithRules(config, job({
      description: `${job().description}\nMandatory:\n- ABAP OO\nPreferred:\n- SAPUI5`,
    }));
    expect(result.mandatoryGaps).toContain('ABAP OO development appears to be mandatory');
    expect(result.recommendation).toBe('Review');
  });

  it('does not transfer a preferred marker to a neighboring mandatory skill', () => {
    const text = jobText(job({ description: 'SAPUI5 is preferred, ABAP OO development is mandatory.' }));
    expect(requirementKind(config, text.all, 'SAPUI5')).toBe('preferred');
    expect(requirementKind(config, text.all, 'ABAP OO development')).toBe('mandatory');
  });

  it('carries a changed preferred marker through the remaining items of that list', () => {
    const text = 'Must have CAP, Node.js, preferred SAPUI5, ABAP OO development.';
    expect(requirementKind(config, text, 'CAP')).toBe('mandatory');
    expect(requirementKind(config, text, 'Node.js')).toBe('mandatory');
    expect(requirementKind(config, text, 'SAPUI5')).toBe('preferred');
    expect(requirementKind(config, text, 'ABAP OO development')).toBe('preferred');
  });

  it('does not carry an inline list marker into an unrelated sentence', () => {
    expect(requirementKind(config, 'Must have CAP, Node.js. We also use ABAP OO development.', 'ABAP OO development')).toBe('unclear');
  });

  it('keeps mandatory precedence when a skill is repeated in a preferred list', () => {
    const text = 'Must have CAP, Node.js, ABAP OO development. Nice to have SAPUI5, ABAP OO development.';
    expect(requirementKind(config, text, 'ABAP OO development')).toBe('mandatory');
  });

  it.each([
    'No freelancers accepted.',
    'Freelancers are not considered.',
    'No contractors accepted.',
    'No B2B.',
    'Keine Freelancer.',
    'Permanent contract only.',
  ])('rejects explicit contract exclusions: %s', (exclusion) => {
    const result = assessWithRules(config, job({ description: `${job().description} ${exclusion}` }));
    expect(result.hardReject).toBe(true);
    expect(result.recommendation).toBe('Skip');
    expect(result.fitScore).toBeLessThanOrEqual(config.scoring.hard_rejects.score_cap);
    expect(result.commercialFit).toBeLessThan(assessWithRules(config, job()).commercialFit);
  });

  it('downgrades a high-scoring mixed role when ABAP OO development is mandatory', () => {
    const result = assessWithRules(config, job({
      description: `${job().description} ABAP OO development is mandatory.`,
    }));
    expect(result.hardReject).toBe(false);
    expect(result.fitScore).toBeGreaterThanOrEqual(config.scoring.thresholds.apply);
    expect(result.mandatoryGaps.join(' ')).toMatch(/ABAP OO/);
    expect(result.recommendation).toBe('Review');
  });

  it('keeps Apply for a positive contract offer with only preferred ABAP OO knowledge', () => {
    const result = assessWithRules(config, job({
      description: `${job().description} ABAP OO development is nice to have.`,
    }));
    expect(result.mandatoryGaps).toEqual([]);
    expect(result.recommendation).toBe('Apply');
  });

  it('rejects an ABAP-only role even when the title mentions SAP', () => {
    const result = assessWithRules(
      config,
      job({
        title: 'Senior ABAP Developer',
        description:
          'Permanent position only. Extensive experience with ABAP OO and the RAP framework is mandatory. Fully on-site in Walldorf. No freelancers.',
        jobType: 'fulltime',
        isRemote: false,
      }),
    );
    expect(result.hardReject).toBe(true);
    expect(result.recommendation).toBe('Skip');
    expect(result.fitScore).toBeLessThanOrEqual(config.scoring.hard_rejects.score_cap);
    expect(result.mandatoryGaps.join(' ')).toMatch(/ABAP/i);
  });

  it('rejects a predominantly functional role', () => {
    const result = assessWithRules(
      config,
      job({
        title: 'SAP IS-U Functional Consultant',
        description: 'Deep IS-U functional expertise is mandatory. Mostly on-site in Warsaw. Fluent Polish is required.',
        jobType: 'fulltime',
        isRemote: null,
      }),
    );
    expect(result.hardReject).toBe(true);
    expect(result.recommendation).toBe('Skip');
  });

  it('rejects a role that makes an unheld language mandatory', () => {
    const result = assessWithRules(
      config,
      job({
        description:
          'Freelance engagement, fully remote. Build CAP services with Node.js and TypeScript. Verhandlungssichere Deutschkenntnisse sind erforderlich.',
      }),
    );
    expect(result.hardReject).toBe(true);
    expect(String(result.hardRejectReason)).toMatch(/language/i);
  });

  it('keeps a mixed BTP/ABAP role in play instead of hard-rejecting it', () => {
    const result = assessWithRules(
      config,
      job({
        title: 'SAP BTP Developer with ABAP background',
        description:
          'You will build CAP applications on SAP BTP with Node.js and TypeScript. ABAP developer knowledge is nice to have for reading existing code. Freelance, fully remote.',
      }),
    );
    expect(result.hardReject).toBe(false);
    expect(result.recommendation).not.toBe('Skip');
  });

  it('separates mandatory gaps from preferred ones', () => {
    const mandatory = assessWithRules(
      config,
      job({ description: `${job().description} SAP IS-U functional consulting is mandatory for this role.` }),
    );
    expect(mandatory.mandatoryGaps.some((gap) => /IS-U/i.test(gap))).toBe(true);

    const preferred = assessWithRules(
      config,
      job({ description: `${job().description} SAP IS-U functional consulting is nice to have.` }),
    );
    expect(preferred.preferredGaps.some((gap) => /IS-U/i.test(gap))).toBe(true);
    expect(preferred.mandatoryGaps.some((gap) => /IS-U/i.test(gap))).toBe(false);
  });
});

describe('configured travel limit', () => {
  it.each([
    'Three onsite days every week are required.',
    'Hybrid: 3 days per week onsite are mandatory.',
    'Required on-site presence: 3 days a week.',
    'Two to three days in the office per week are required.',
    'Five onsite days per month are required.',
  ])('hard-rejects attendance above the four-day monthly limit: %s', (attendance) => {
    const result = assessWithRules(config, job({ description: `${job().description}\n${attendance}` }));
    expect(result.hardReject).toBe(true);
    expect(result.recommendation).toBe('Skip');
    expect(result.fitScore).toBeLessThanOrEqual(config.scoring.hard_rejects.score_cap);
    expect(result.mandatoryGaps.join(' ')).toMatch(/profile limit \(4 days\/month\)/);
  });

  it('allows explicitly stated attendance at the configured limit', () => {
    const result = assessWithRules(config, job({ description: `${job().description} Four onsite days per month are required.` }));
    expect(result.hardReject).toBe(false);
  });

  it('uses the edited travel limit rather than a fixed weekly rejection rule', () => {
    const changed = structuredClone(config);
    changed.profile.travel!.max_onsite_days_per_month = 12;
    const result = assessWithRules(changed, job({ description: `${job().description} Three onsite days every week are required.` }));
    expect(result.hardReject).toBe(false);
  });

  it('does not count remote days as onsite attendance', () => {
    const result = assessWithRules(config, job({ description: `${job().description} Three days per week remote and one day per week onsite.` }));
    expect(result.hardReject).toBe(false);
  });

  it('keeps an unspecified attendance frequency unknown', () => {
    const result = assessWithRules(config, job({ description: `${job().description} Occasional onsite meetings.` }));
    expect(result.hardReject).toBe(false);
  });

  it.each([
    'Optional: five onsite days per month.',
    'Five onsite days per month are not required.',
    'Five onsite days per month are not mandatory.',
    "Five onsite days per month aren't required.",
    'You do not have to attend five onsite days per month.',
    'No mandatory onsite attendance: five days per month.',
    'No onsite attendance required: five days per month.',
    'There is no need for five onsite days per month.',
  ])('keeps optional or negated attendance out of hard rejects: %s', (attendance) => {
    const vacancy = job({ description: `Fully remote. ${attendance}` });
    const text = jobText(vacancy);
    expect(onsiteDaysPerMonth(config, text.all)).toEqual({ mandatory: null, optional: 5, unclear: null });
    expect(detectWorkMode(config, vacancy, text)).toBe('fully_remote');
    const result = assessWithRules(config, vacancy);
    expect(result.hardReject).toBe(false);
    expect(result.mandatoryGaps.join(' ')).not.toMatch(/onsite attendance/);
  });

  it.each([
    'Hybrid: 3 days per week onsite.',
    'On-site presence: 3 days a week.',
    'Two to three days in the office per week.',
    'SAPUI5 is optional. Three onsite days every week.',
    'SAPUI5 is not required, three onsite days every week.',
  ])('reports unclear obligation instead of rejecting an unqualified frequency: %s', (attendance) => {
    expect(onsiteDaysPerMonth(config, attendance)).toEqual({ mandatory: null, optional: null, unclear: 12 });
    const result = assessWithRules(config, job({ description: `${job().description}\n${attendance}` }));
    expect(result.hardReject).toBe(false);
    expect(result.missingInformation).toContain('unclear whether onsite attendance (12.0 days/month) is mandatory');
  });

  it.each([
    'Optional SAPUI5 knowledge, three onsite days every week are required.',
    'Optional SAPUI5 knowledge and three onsite days every week are required.',
    'Five onsite days per month are not required, but three onsite days every week are required.',
    'Optional: five onsite days per month. Three onsite days every week are required.',
    'Three onsite days every week are not optional.',
  ])('keeps an independent required frequency mandatory: %s', (attendance) => {
    expect(onsiteDaysPerMonth(config, attendance).mandatory).toBe(12);
    expect(assessWithRules(config, job({ description: `${job().description}\n${attendance}` })).hardReject).toBe(true);
  });
});

describe('uncertainty handling', () => {
  it('never recommends Apply for a job whose description was not retrieved', () => {
    const result = assessWithRules(config, job({ description: null, descriptionHash: null }));
    expect(result.recommendation).not.toBe('Apply');
    expect(result.fitScore).toBeLessThanOrEqual(config.scoring.uncertainty.cap_without_description);
    expect(result.missingInformation.join(' ')).toMatch(/description/i);
  });

  it('reports an unknown rate as missing information rather than rejecting or accepting', () => {
    const result = assessWithRules(
      config,
      job({ salaryMin: null, salaryMax: null, salaryInterval: null, salaryCurrency: null }),
    );
    expect(result.missingInformation).toContain('rate not stated');
    expect(result.hardReject).toBe(false);
  });

  it('reports an unknown contract type and work mode without rejecting the job', () => {
    const unknown = job({
      jobType: null,
      isRemote: null,
      description: 'SAP BTP role. CAP and Node.js are used. No further details provided.',
    });
    const result = assessWithRules(config, unknown);
    expect(result.missingInformation.join(' ')).toMatch(/contract type not stated/);
    expect(result.missingInformation.join(' ')).toMatch(/work mode/);
    expect(result.hardReject).toBe(false);

    // Unknown must sit between a clearly bad and a clearly good posting,
    // never collapse to either extreme.
    const bad = assessWithRules(
      config,
      job({
        jobType: 'fulltime',
        isRemote: false,
        description: 'SAP BTP role. CAP and Node.js are used. Permanent position, fully on-site in Munich.',
      }),
    );
    const good = assessWithRules(
      config,
      job({ description: 'SAP BTP role. CAP and Node.js are used. Freelance contract, 100% remote.' }),
    );
    expect(result.fitScore).toBeGreaterThan(bad.fitScore);
    expect(result.fitScore).toBeLessThan(good.fitScore);
  });

  it('does not assume work authorisation outside the preferred region', () => {
    const result = assessWithRules(config, job({ location: 'Austin, TX, US', locationCountry: 'United States' }));
    expect(result.missingInformation.join(' ')).toMatch(/work authorisation/i);
  });
});

describe('prescreen', () => {
  it('drops obviously irrelevant titles cheaply', () => {
    expect(prescreen(config, job({ title: 'Technical Recruiter', description: 'We hire SAP people.' })).passed).toBe(false);
    expect(
      prescreen(config, job({ title: 'Working Student SAP', description: 'Support our SAP team with small tasks.' }))
        .passed,
    ).toBe(false);
  });

  it('rescues an excluded title when the body is clearly in scope', () => {
    expect(
      prescreen(config, job({ title: 'ABAP and BTP Developer', description: 'CAP, Node.js and BTP work.' })).passed,
    ).toBe(true);
  });
});

describe('CV variant recommendation', () => {
  it('only ever returns a configured variant id', () => {
    const ids = config.cvVariants.variants.map((variant) => variant.id);
    for (const title of ['SAP CPI Developer', 'SAP Fiori Developer', 'SAP AI Developer', 'SAP BTP Architect', 'Chef']) {
      expect(ids).toContain(suggestCvVariant(config, jobText(job({ title }))));
    }
  });

  it('picks the integration CV for a CPI role', () => {
    expect(
      suggestCvVariant(
        config,
        jobText(
          job({
            title: 'SAP Integration Suite / CPI Developer',
            description: 'Design iFlows in SAP CPI, configure destinations, OAuth and principal propagation to S/4HANA.',
          }),
        ),
      ),
    ).toBe('cpi');
  });
});
