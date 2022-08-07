import { describe, it, expect, beforeEach, jest } from '@jest/globals';

import { filterTemplates, parseCommand } from './multiplex-templates';
import type { Templates } from './multiplex-templates';

jest.mock('../code/lib/cli/src/repro-templates', () => () => ({}));
const mockOptions = { foo: { values: ['bar', 'baz'] } };
jest.mock('./sandbox', () => ({ options: mockOptions }));

describe('parseCommand', () => {
  it('grabs the script name and gets its options', async () => {
    expect(await parseCommand(`yarn sandbox --foo bar`)).toEqual({
      scriptName: 'sandbox',
      command: 'yarn sandbox',
      options: mockOptions,
      values: { foo: 'bar' },
    });
  });
});

describe('filterTemplates', () => {
  const templates: Templates = {
    first: {
      name: 'First',
      script: 'first',
      cadence: ['ci', 'daily'],
      skipScripts: ['sandbox'],
    },
    second: {
      name: 'Second',
      script: 'second',
      cadence: ['daily'],
    },
  };
  it('filters only templates on the right cadence', () => {
    expect(filterTemplates(templates, 'ci', 'smoketest')).toEqual({ first: templates.first });
    expect(filterTemplates(templates, 'daily', 'smoketest')).toEqual(templates);
  });

  it('filters templates that do not skip the script', () => {
    expect(filterTemplates(templates, 'daily', 'sandbox')).toEqual({ second: templates.second });
    expect(filterTemplates(templates, 'daily', 'smoketest')).toEqual(templates);
  });

  // TODO: test for this, I don't really want to mess with circle env vars duing a test
  // it('filters by CI concurrency', () => {
  //   expect(filterTemplates(templates, 'daily', 'sandbox')).toEqual({ second: templates.second });
  //   expect(filterTemplates(templates, 'daily', 'smoketest')).toEqual(templates);
  // });
});
