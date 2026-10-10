import { describe, expect, it } from 'vitest';
import { daysBetween, parseIsoDate } from '../src/core/dates.ts';
import { createReplacementCheck, referenceMessage } from '../src/core/messages.ts';
import { type Assessment, assess, assessAll, compareSeverity } from '../src/core/severity.ts';
import type { IsoDate, Registry, RegistryEntry, Replacement } from '../src/core/types.ts';

const TODAY = '2099-01-01' as IsoDate;

function entry(overrides: Partial<RegistryEntry>): RegistryEntry {
  return {
    id: 'openai:x',
    provider: 'openai',
    platform: 'openai',
    model_id: 'x',
    version: null,
    aliases: [],
    status: 'active',
    deprecation_date: null,
    retirement_date: null,
    retirement_date_qualifier: 'exact',
    recommended_replacements: [],
    drop_in: false,
    source: 'fixture/fixture',
    source_url: 'https://fixture.invalid/',
    source_excerpt: null,
    verified_on: TODAY,
    notes: null,
    ...overrides,
  };
}

describe('dates', () => {
  it.each([
    ['2099-01-01', true],
    ['2096-02-29', true],
    ['2099-02-29', false],
    ['2099-13-01', false],
    ['2099-1-01', false],
    ['20990101', false],
    ['2099-01-01T00:00:00Z', false],
  ])('parseIsoDate(%s) is valid: %s', (text, valid) => {
    expect(parseIsoDate(text) !== null).toBe(valid);
  });

  it('counts whole UTC days, across month, year and leap boundaries', () => {
    const d = (s: string) => s as IsoDate;
    expect(daysBetween(d('2099-01-01'), d('2099-01-01'))).toBe(0);
    expect(daysBetween(d('2098-12-31'), d('2099-01-01'))).toBe(1);
    expect(daysBetween(d('2096-02-28'), d('2096-03-01'))).toBe(2);
    expect(daysBetween(d('2099-01-10'), d('2099-01-01'))).toBe(-9);
  });
});

describe('severity table', () => {
  const legacy = { legacy: false };
  it.each<[string, Partial<RegistryEntry>, string | null]>([
    ['status retired, no date', { status: 'retired' }, 'error model-retired'],
    [
      'retirement date in the past',
      { status: 'deprecated', retirement_date: '2098-12-31' as IsoDate },
      'error model-retired',
    ],
    [
      'retirement date today',
      { status: 'deprecated', retirement_date: TODAY },
      'error model-retired',
    ],
    [
      'retires tomorrow',
      { status: 'deprecated', retirement_date: '2099-01-02' as IsoDate },
      'error model-retiring',
    ],
    [
      'retires in 29 days',
      { status: 'deprecated', retirement_date: '2099-01-30' as IsoDate },
      'error model-retiring',
    ],
    [
      'retires in 30 days',
      { status: 'deprecated', retirement_date: '2099-01-31' as IsoDate },
      'warning model-retiring',
    ],
    [
      'retires in 89 days',
      { status: 'deprecated', retirement_date: '2099-03-31' as IsoDate },
      'warning model-retiring',
    ],
    [
      'retires in 90 days, deprecated',
      { status: 'deprecated', retirement_date: '2099-04-01' as IsoDate },
      'notice model-deprecated',
    ],
    [
      'active with an announced date in < 30 days',
      { status: 'active', retirement_date: '2099-01-15' as IsoDate },
      'error model-retiring',
    ],
    [
      'active with a date in < 90 days',
      { status: 'active', retirement_date: '2099-03-01' as IsoDate },
      'warning model-retiring',
    ],
    [
      'active with a date far away',
      { status: 'active', retirement_date: '2100-01-01' as IsoDate },
      null,
    ],
    ['active, no date', { status: 'active' }, null],
    ['deprecated, no retirement date', { status: 'deprecated' }, 'notice model-deprecated'],
    ['unverified', { status: 'unverified' }, 'notice model-unverified'],
    ['legacy (not opted in)', { status: 'legacy' }, null],
    [
      'no_earlier_than uses the same thresholds',
      {
        status: 'deprecated',
        retirement_date: '2099-01-20' as IsoDate,
        retirement_date_qualifier: 'no_earlier_than',
      },
      'error model-retiring',
    ],
    [
      'active, no_earlier_than in < 30 days: at most a warning',
      {
        status: 'active',
        retirement_date: '2099-01-20' as IsoDate,
        retirement_date_qualifier: 'no_earlier_than',
      },
      'warning model-retiring',
    ],
    [
      'active, no_earlier_than has passed: still a warning',
      {
        status: 'active',
        retirement_date: '2098-06-01' as IsoDate,
        retirement_date_qualifier: 'no_earlier_than',
      },
      'warning model-retiring',
    ],
    [
      'active, no_earlier_than far away',
      {
        status: 'active',
        retirement_date: '2099-12-01' as IsoDate,
        retirement_date_qualifier: 'no_earlier_than',
      },
      null,
    ],
    [
      'deprecated, no_earlier_than has passed: error, but not retired',
      {
        status: 'deprecated',
        retirement_date: '2098-06-01' as IsoDate,
        retirement_date_qualifier: 'no_earlier_than',
      },
      'error model-retiring',
    ],
    [
      'active with an exact date that has passed',
      { status: 'active', retirement_date: '2098-06-01' as IsoDate },
      'error model-retired',
    ],
  ])('%s → %s', (_, overrides, expected) => {
    const result = assess(entry(overrides), TODAY, legacy);
    expect(result ? `${result.severity} ${result.rule}` : null).toBe(expected);
  });

  it('reports legacy entries as notices when opted in', () => {
    expect(assess(entry({ status: 'legacy' }), TODAY, { legacy: true })).toEqual({
      severity: 'notice',
      rule: 'model-legacy',
      daysLeft: null,
    });
  });

  it('gives the days left', () => {
    const e = entry({ status: 'deprecated', retirement_date: '2099-01-10' as IsoDate });
    expect(assess(e, TODAY, legacy)?.daysLeft).toBe(9);
  });

  it('picks the most severe entry, then the earliest date', () => {
    const later = entry({
      id: 'a',
      status: 'deprecated',
      retirement_date: '2099-03-01' as IsoDate,
    });
    const earlier = entry({
      id: 'b',
      status: 'deprecated',
      retirement_date: '2099-02-01' as IsoDate,
    });
    const notice = entry({
      id: 'c',
      status: 'deprecated',
      retirement_date: '2099-12-01' as IsoDate,
    });
    const undated = entry({ id: 'd', status: 'deprecated' });
    expect(assessAll([notice, later, earlier], TODAY, legacy)?.entry.id).toBe('b');
    expect(assessAll([undated, notice], TODAY, legacy)?.entry.id).toBe('c');
    expect(assessAll([notice, undated], TODAY, legacy)?.entry.id).toBe('c');
    expect(assessAll([entry({ status: 'active' })], TODAY, legacy)).toBeNull();
  });

  it('orders severities', () => {
    expect(['notice', 'error', 'warning'].sort(compareSeverity as never)).toEqual([
      'error',
      'warning',
      'notice',
    ]);
  });
});

describe('messages for no-earlier-than dates', () => {
  it('says a passed date means the model may be retired at any time', () => {
    const e = entry({
      status: 'active',
      retirement_date: '2098-06-01' as IsoDate,
      retirement_date_qualifier: 'no_earlier_than',
    });
    const assessment = assess(e, TODAY, { legacy: false });
    expect(assessment).not.toBeNull();
    expect(referenceMessage('x', e, assessment as Assessment, [e], { kind: 'literal' })).toBe(
      'x (openai) may be retired at any time (announced retirement no earlier than 2098-06-01).',
    );
  });
});

describe('messages for approximate dates', () => {
  const at = (overrides: Partial<RegistryEntry>) => {
    const e = entry({ retirement_date_qualifier: 'approximate', ...overrides });
    return referenceMessage('x', e, assess(e, TODAY, { legacy: false }) as Assessment, [e], {
      kind: 'literal',
    });
  };

  it("says a passed date is when the model was due to go, unless it's retired", () => {
    expect(at({ status: 'deprecated', retirement_date: '2098-12-01' as IsoDate })).toBe(
      'x (openai) was due to retire around 2098-12-01.',
    );
    expect(at({ status: 'retired', retirement_date: '2098-12-01' as IsoDate })).toBe(
      'x (openai) was retired around 2098-12-01.',
    );
    expect(at({ status: 'deprecated', retirement_date: '2099-01-20' as IsoDate })).toBe(
      'x (openai) retires around 2099-01-20, in 19 days.',
    );
  });
});

describe('IDs shared across platforms', () => {
  const legacy = { legacy: false };
  const soon = '2099-01-10' as IsoDate;
  const on = (platform: RegistryEntry['platform'], overrides: Partial<RegistryEntry> = {}) =>
    entry({ id: `${platform}:x`, platform, status: 'deprecated', ...overrides });

  it('keeps an error when every platform says error', () => {
    const result = assessAll(
      [on('gemini-api', { retirement_date: soon }), on('vertex', { status: 'retired' })],
      TODAY,
      legacy,
    );
    expect(result?.assessment.severity).toBe('error');
    expect(result?.unaffected).toEqual([]);
  });

  it('downgrades to a warning when another platform is fine, and names it', () => {
    const vertex = on('vertex', { retirement_date: soon });
    const result = assessAll([on('gemini-api', { status: 'active' }), vertex], TODAY, legacy);
    expect(result?.entry).toBe(vertex);
    expect(result?.assessment).toEqual({
      severity: 'warning',
      rule: 'model-retiring',
      daysLeft: 9,
    });
    expect(result?.unaffected).toEqual(['gemini-api']);
    expect(
      referenceMessage(
        'x',
        vertex,
        result?.assessment as Assessment,
        [vertex],
        { kind: 'literal' },
        {
          unaffected: ['gemini-api'],
        },
      ),
    ).toBe(
      "x (vertex) retires on 2099-01-10, in 9 days. Reported as a warning, not an error: the ID is also served on gemini-api, where it isn't an error.",
    );
  });

  it('downgrades when the other platform only has a notice', () => {
    const result = assessAll(
      [on('vertex', { retirement_date: soon }), on('gemini-api')],
      TODAY,
      legacy,
    );
    expect(result?.assessment.severity).toBe('warning');
  });

  it('never downgrades across regions of one platform', () => {
    const govcloud = on('bedrock', { retirement_date: soon, regions: ['us-gov-west-1'] });
    const result = assessAll([on('bedrock', { status: 'active' }), govcloud], TODAY, legacy);
    expect(result?.entry).toBe(govcloud);
    expect(result?.assessment.severity).toBe('error');
  });

  it('leaves warnings and notices alone', () => {
    const result = assessAll(
      [
        on('vertex', { retirement_date: '2099-02-15' as IsoDate }),
        on('gemini-api', { status: 'active' }),
      ],
      TODAY,
      legacy,
    );
    expect(result?.assessment.severity).toBe('warning');
    expect(result?.unaffected).toEqual([]);
  });
});

describe('replacements that are retired or retiring themselves', () => {
  const to = (model_id: string): Replacement => ({ model_id, platform: 'openai' });
  const model = (id: string, overrides: Partial<RegistryEntry>) =>
    entry({ id: `openai:${id}`, model_id: id, status: 'retired', ...overrides });
  const a = model('a', {
    retirement_date: '2098-01-01' as IsoDate,
    recommended_replacements: [to('b')],
  });
  const registry: Registry = {
    schema_version: 1,
    registry_version: 1,
    generated_at: '2099-01-01T00:00:00Z',
    models: [
      a,
      model('b', { retirement_date: '2098-06-01' as IsoDate, recommended_replacements: [to('c')] }),
      model('c', {
        status: 'deprecated',
        retirement_date: '2099-01-10' as IsoDate,
        recommended_replacements: [to('d')],
      }),
      // `d` isn't in the registry: no retirement has been announced for it.
      model('e', { status: 'deprecated', retirement_date: '2099-12-01' as IsoDate }),
      model('loop1', {
        retirement_date: '2098-01-01' as IsoDate,
        recommended_replacements: [to('loop2')],
      }),
      model('loop2', {
        retirement_date: '2098-01-01' as IsoDate,
        recommended_replacements: [to('loop1')],
      }),
    ],
  };
  const check = createReplacementCheck(registry, TODAY);

  it('follows the chain of replacements to the first model not in trouble', () => {
    expect(check(to('b'))).toEqual({ status: 'retired on 2098-06-01', next: to('d') });
    expect(check(to('c'))).toEqual({ status: 'retiring on 2099-01-10', next: to('d') });
    expect(check(to('d'))).toBeNull();
    // Deprecated with retirement 90 days or more away isn't trouble yet.
    expect(check(to('e'))).toBeNull();
    expect(check(to('loop1'))).toEqual({ status: 'retired on 2098-01-01', next: null });
  });

  it('says so in the message', () => {
    const assessment = assess(a, TODAY, { legacy: false }) as Assessment;
    expect(
      referenceMessage('a', a, assessment, [a], { kind: 'literal' }, { replacements: check }),
    ).toBe(
      'a (openai) was retired on 2098-01-01. Recommended replacement: b (openai; itself retired on 2098-06-01, replaced by d).',
    );
  });
});
