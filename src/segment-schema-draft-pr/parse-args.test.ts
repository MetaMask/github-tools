import { parseCliArgs } from './parse-args';

describe('parseCliArgs', () => {
  it('parses required flags and optional previous-dir', () => {
    const args = parseCliArgs(
      [
        '--phase',
        'generate',
        '--mode',
        'propose',
        '--platform',
        'mobile',
        '--schema',
        '../segment-schema',
        '--client-repository',
        'MetaMask/metamask-mobile',
        '--base-sha',
        'aaa',
        '--head-sha',
        'bbb',
        '--pr-number',
        '12',
        '--previous-dir',
        '../segment-schema-previous',
        '--dry-run',
      ],
      {
        GITHUB_TOKEN: 'ghs_client',
        SEGMENT_SCHEMA_TOKEN: 'ghs_schema',
      },
    );

    expect(args.phase).toBe('generate');
    expect(args.previousDir).toBe('../segment-schema-previous');
    expect(args.dryRun).toBe(true);
    expect(args.prNumber).toBe(12);
    expect(args.clientRepository).toBe('MetaMask/metamask-mobile');
    expect(args.noAnalyticsDiff).toBe(false);
    expect(args.tooManyFiles).toBe(false);
  });

  it('parses --no-analytics-diff and --too-many-files', () => {
    const args = parseCliArgs(
      [
        '--phase',
        'publish',
        '--mode',
        'propose',
        '--platform',
        'mobile',
        '--no-analytics-diff',
        '--too-many-files',
      ],
      {},
    );

    expect(args.noAnalyticsDiff).toBe(true);
    expect(args.tooManyFiles).toBe(true);
  });
});
