import { extractAnalyticsModel } from './analytics-model';
import { getPlatformConfig } from './config';

const MOBILE = getPlatformConfig('mobile');
const EXTENSION = getPlatformConfig('extension');

describe('extractAnalyticsModel', () => {
  it('reads EVENT_NAME catalog members', () => {
    const source = `
      enum EVENT_NAME {
        APP_OPENED = 'App Opened',
        BUTTON_CLICKED = 'Button Clicked',
      }
    `;
    const model = extractAnalyticsModel('catalog.ts', source, MOBILE);
    expect(model.catalog.get('APP_OPENED')).toBe('App Opened');
    expect(model.catalog.get('BUTTON_CLICKED')).toBe('Button Clicked');
  });

  it('extracts createEventBuilder addProperties and addSensitiveProperties literals', () => {
    const source = `
      enum EVENT_NAME {
        APP_OPENED = 'App Opened',
      }
      const MetaMetricsEvents = { APP_OPENED: EVENT_NAME.APP_OPENED };
      createEventBuilder(MetaMetricsEvents.APP_OPENED)
        .addProperties({ usdValue: '1', count: 2, enabled: true, tags: ['a'] })
        .addSensitiveProperties({ secret: 'x' })
        .build();
    `;
    const model = extractAnalyticsModel('call.ts', source, MOBILE);
    const event = model.events.get('App Opened');
    expect(event?.properties.get('usd_value')).toBe('string');
    expect(event?.properties.get('count')).toBe('number');
    expect(event?.properties.get('enabled')).toBe('boolean');
    expect(event?.properties.get('tags')).toBe('array');
    expect(event?.properties.get('secret')).toBe('string');
  });

  it('ignores generateOpt action and name properties', () => {
    const source = `
      enum EVENT_NAME {
        APP_OPENED = 'App Opened',
      }
      createEventBuilder(MetaMetricsEvents.APP_OPENED).addProperties({
        action: 'click',
        name: 'App Opened',
        location: 'Home',
      });
    `;
    const model = extractAnalyticsModel('call.ts', source, MOBILE);
    const event = model.events.get('App Opened');
    expect(event?.properties.has('action')).toBe(false);
    expect(event?.properties.has('name')).toBe(false);
    expect(event?.properties.get('location')).toBe('string');
  });

  it('extracts extension trackEvent property bags', () => {
    const source = `
      enum MetaMetricsEventName {
        AppOpened = 'App Opened',
      }
      trackEvent({
        event: MetaMetricsEventName.AppOpened,
        properties: { chainId: '0x1', nested: true },
      });
    `;
    const model = extractAnalyticsModel('ui.ts', source, EXTENSION);
    const event = model.events.get('App Opened');
    expect(event?.properties.get('chain_id')).toBe('string');
    expect(event?.properties.get('nested')).toBe('boolean');
  });

  it('marks spreads, helpers, and unknown identifiers as unresolved', () => {
    const source = `
      enum EVENT_NAME {
        APP_OPENED = 'App Opened',
      }
      createEventBuilder(MetaMetricsEvents.APP_OPENED).addProperties({
        ...extra,
        helper: getProps(),
      });
    `;
    const model = extractAnalyticsModel('call.ts', source, MOBILE);
    const event = model.events.get('App Opened');
    expect(event?.unresolved).toStrictEqual([
      { eventName: 'App Opened', key: '...', file: 'call.ts' },
      { eventName: 'App Opened', key: 'helper', file: 'call.ts' },
    ]);
  });

  it('resolves same-file as const object property types', () => {
    const source = `
      enum EVENT_NAME {
        APP_OPENED = 'App Opened',
      }
      const Props = { usdValue: '1' } as const;
      createEventBuilder(MetaMetricsEvents.APP_OPENED).addProperties({
        amount: Props.usdValue,
      });
    `;
    const model = extractAnalyticsModel('call.ts', source, MOBILE);
    expect(model.events.get('App Opened')?.properties.get('amount')).toBe(
      'string',
    );
  });

  it('resolves event names using a shared catalog from another file', () => {
    const { catalog } = extractAnalyticsModel(
      'catalog.ts',
      `enum EVENT_NAME { NEW_EVENT = 'New Event' }`,
      MOBILE,
    );
    const model = extractAnalyticsModel(
      'call.ts',
      `createEventBuilder(MetaMetricsEvents.NEW_EVENT).addProperties({ source: 'banner' });`,
      MOBILE,
      catalog,
    );
    expect(model.events.get('New Event')?.properties.get('source')).toBe(
      'string',
    );
  });
});
