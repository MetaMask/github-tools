import ora from 'ora';

import { tallyCommentsWithReferencesToContributorDocsByQuarter } from './utils';
import type { TalliedQuarter } from './utils';
import { log } from '../../logging-utils';

/**
 * The repositories we want to scan.
 */
const REPOSITORY_NAMES = [
  'core',
  'design-tokens',
  'metamask-extension',
  'metamask-mobile',
  'snaps',
] as const;

type RepositoryName = (typeof REPOSITORY_NAMES)[number];

/**
 * It is not necessary for us to query all of the pull requests or pull requests
 * comments for all time; we only need those since at least Q2 2023, which is
 * when the Shared Libraries decided to start working on the contributor docs.
 */
const START_DATE = new Date(Date.UTC(2023, 3, 1));

main().catch(console.error);

/**
 * This script counts the number of references to the `contributor-docs` repo
 * across a selection of MetaMask repositories.
 */
async function main() {
  const spinner = ora();

  console.log(
    'About to retrieve data. Please be patient, this could take a while:\n',
  );

  const quartersByRepositoryName: Partial<
    Record<RepositoryName, TalliedQuarter[]>
  > = {};
  // NOTE: We can't do this in parallel or else we'll get rate limits.
  for (const repositoryName of REPOSITORY_NAMES) {
    spinner.start(
      `Retrieving data for ${repositoryName} since ${START_DATE.toISOString()}`,
    );
    log('');
    try {
      const quarters =
        await tallyCommentsWithReferencesToContributorDocsByQuarter({
          repositoryName,
          since: START_DATE,
        });
      quartersByRepositoryName[repositoryName] = quarters;
      spinner.succeed();
    } catch (error) {
      spinner.fail();
      throw error;
    }
  }

  const grandTotal = Object.values(quartersByRepositoryName).reduce(
    (sum1, quarters) => {
      return sum1 + quarters.reduce((sum2, quarter) => sum2 + quarter.total, 0);
    },
    0,
  );

  console.log('\n----------------------\n');
  console.log('Number of references to contributor-docs by repository:\n');
  for (const [repositoryName, quarters] of Object.entries(
    quartersByRepositoryName,
  )) {
    console.log(`- ${repositoryName}`);

    for (const quarter of quarters) {
      console.log(`  - ${quarter.name}: ${quarter.total}`);
    }
  }
  console.log(`\nTotal number of references: ${grandTotal}`);
}
