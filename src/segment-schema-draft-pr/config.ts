import type { Platform, PlatformConfig } from './types';

const MOBILE_CONFIG: PlatformConfig = {
  catalogFile: 'app/core/Analytics/MetaMetrics.events.ts',
  enumName: 'EVENT_NAME',
  eventRefPrefix: 'MetaMetricsEvents',
  trackingPlan: 'tracking-plans/metamask-mobile.yaml',
  globals: 'metamask-mobile-globals',
  defaultLibrary: 'metamask-mobile-unsorted',
};

const EXTENSION_CONFIG: PlatformConfig = {
  catalogFile: 'shared/constants/metametrics.ts',
  enumName: 'MetaMetricsEventName',
  eventRefPrefix: 'MetaMetricsEventName',
  trackingPlan: 'tracking-plans/metamask-extension.yaml',
  globals: 'metamask-extension-globals',
  defaultLibrary: 'metamask-extension-unsorted',
};

/**
 * Returns the per-platform catalog and schema paths.
 *
 * @param platform - Mobile or extension.
 * @returns Catalog file, enum, tracking plan, and unsorted library ids.
 */
export function getPlatformConfig(platform: Platform): PlatformConfig {
  return platform === 'mobile' ? MOBILE_CONFIG : EXTENSION_CONFIG;
}

/**
 * Builds the deterministic bot branch for one client PR.
 *
 * @param platform - Mobile or extension.
 * @param prNumber - Client pull request number.
 * @returns Branch name `metamaskbot/<platform>-pr-<N>`.
 */
export function botBranchName(platform: Platform, prNumber: number): string {
  return `metamaskbot/${platform}-pr-${prNumber}`;
}
