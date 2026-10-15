import { getPlatformConfig, botBranchName } from './config';

describe('config', () => {
  it('returns mobile catalog and unsorted library paths', () => {
    expect(getPlatformConfig('mobile')).toStrictEqual({
      catalogFile: 'app/core/Analytics/MetaMetrics.events.ts',
      enumName: 'EVENT_NAME',
      eventRefPrefix: 'MetaMetricsEvents',
      trackingPlan: 'tracking-plans/metamask-mobile.yaml',
      globals: 'metamask-mobile-globals',
      defaultLibrary: 'metamask-mobile-unsorted',
    });
  });

  it('returns extension catalog and unsorted library paths', () => {
    expect(getPlatformConfig('extension')).toStrictEqual({
      catalogFile: 'shared/constants/metametrics.ts',
      enumName: 'MetaMetricsEventName',
      eventRefPrefix: 'MetaMetricsEventName',
      trackingPlan: 'tracking-plans/metamask-extension.yaml',
      globals: 'metamask-extension-globals',
      defaultLibrary: 'metamask-extension-unsorted',
    });
  });

  it('builds the deterministic bot branch name', () => {
    expect(botBranchName('mobile', 42)).toBe('metamaskbot/mobile-pr-42');
  });
});
