import { getProcessEnv, getRequiredEnvironmentVariable } from './env-utils';

describe('env-utils', () => {
  it('returns the process environment map', () => {
    expect(typeof getProcessEnv()).toBe('object');
    expect(getProcessEnv().PATH).toBeDefined();
  });

  it('throws when a required variable is missing', () => {
    expect(() =>
      getRequiredEnvironmentVariable('GITHUB_TOOLS_MISSING_ENV_VAR'),
    ).toThrow('Must set GITHUB_TOOLS_MISSING_ENV_VAR');
  });
});
