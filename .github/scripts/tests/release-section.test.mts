import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractReleaseSection,
  replaceReleaseSection,
} from '../release-section.mts';

test('finds the heading line even when its text appears earlier', () => {
  const changelog =
    '<!-- ## [1.0.0] -->\n\n## [1.0.0]\n\n- Real entry (#1)\n\n## [0.9.0]\n';

  assert.equal(
    extractReleaseSection(changelog, '1.0.0').section,
    '## [1.0.0]\n\n- Real entry (#1)',
  );
});

test('writes a replacement in the changelog line endings', () => {
  const changelog = '## [1.0.0]\r\n\r\n- Old (#1)\r\n\r\n## [0.9.0]\r\n';

  assert.equal(
    replaceReleaseSection(changelog, '1.0.0', '## [1.0.0]\n\n- New (#1)'),
    '## [1.0.0]\r\n\r\n- New (#1)\r\n\r\n## [0.9.0]\r\n',
  );
});

test('ends the oldest release section before the link references', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [13.51.0]',
    '',
    '### Fixed',
    '',
    '- Fixed an issue (#101)',
    '',
    '[Unreleased]: https://example.com/HEAD',
    '[13.51.0]: https://example.com/13.51.0',
    '',
  ].join('\n');

  assert.equal(
    extractReleaseSection(changelog, '13.51.0').section,
    '## [13.51.0]\n\n### Fixed\n\n- Fixed an issue (#101)',
  );
  assert.equal(
    replaceReleaseSection(
      changelog,
      '13.51.0',
      '## [13.51.0]\n\n### Added\n\n- Added a feature (#102)',
    ),
    changelog
      .replace('### Fixed', '### Added')
      .replace('Fixed an issue (#101)', 'Added a feature (#102)'),
  );
});
