import { countCommentsWithReferencesToContributorDocs } from './utils';

const INTERESTING_REPOSITORY_NAMES = [
  'core',
  'design-tokens',
  'metamask-extension',
  'metamask-mobile',
  'snaps',
];

const MAX_NUMBER_OF_COMMENTS_PER_REPO = 5000;

main().catch(console.error);

/**
 * This script counts the number of references to the `contributor-docs` repo
 * across the primary repositories used by the MetaMask Core lane.
 */
async function main() {
  console.log('Fetching data, please wait (could take a while)...');

  let total = 0;
  // Can't do this in parallel or else we get rate limits
  for (const repositoryName of INTERESTING_REPOSITORY_NAMES) {
    total += await countCommentsWithReferencesToContributorDocs({
      repositoryName,
      sampleSize: MAX_NUMBER_OF_COMMENTS_PER_REPO,
    });
  }

  console.log(
    `Number of comments with references to contributor documentation: ${total}`,
  );
}
