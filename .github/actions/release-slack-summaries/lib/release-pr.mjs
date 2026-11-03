/**
 * Port of Zap 597 `fetch-release-pr.js`.
 * metamask-zaps@dc70d6792cbaf9d99f39982868baf7f090dea0af.
 *
 * The GraphQL search is gone: the release pull request comes from the open
 * `release/X.Y.Z` → `stable` list. The title check and `extractDownloadUrls`
 * regexes are unchanged. The original `bug.platform` reference was a
 * ReferenceError (`bug` is not in scope); the message now interpolates
 * `platform`.
 */

/**
 * Extracts Chrome and Firefox build URLs from a comment.
 *
 * @param {string} comment - Comment body.
 * @param {string} platform - `Extension` or `Mobile`.
 * @returns {{ downloadUrl1: string | undefined, downloadUrl2: string | undefined }} Build URLs.
 */
export function extractDownloadUrls(comment, platform) {
  let downloadUrl1;
  let downloadUrl2;
  if (platform === 'Extension') {
    const chromeUrlMatch = comment.match(
      /<a href="(https:\/\/[^"]*metamask-extension\/[^"]*\/build-dist-browserify\/builds\/metamask-chrome-[^"]+\.zip)"/u,
    );
    const firefoxUrlMatch = comment.match(
      /<a href="(https:\/\/[^"]*metamask-extension\/[^"]*\/build-dist-mv2-browserify\/builds\/metamask-firefox-[^"]+\.zip)"/u,
    );
    downloadUrl1 = chromeUrlMatch ? chromeUrlMatch[1] : undefined;
    downloadUrl2 = firefoxUrlMatch ? firefoxUrlMatch[1] : undefined;
  } else if (platform === 'Mobile') {
    // To be implemented when we have mobile builds
  } else {
    throw new Error(`Shall never happen: unknown platform (${platform})`);
  }

  return {
    downloadUrl1,
    downloadUrl2,
  };
}

/**
 * Prefer a title containing `release: V`, then require an exact
 * case-insensitive `Release: V`. Throws (no Slack post) on mismatch,
 * as the Zap does.
 *
 * @param {object[]} pulls - Candidate pull requests for one version.
 * @param {string} releaseVersion - `X.Y.Z`.
 * @param {string} githubCodeRepo - Repository name.
 * @returns {object} The release pull request.
 */
export function selectReleasePr(pulls, releaseVersion, githubCodeRepo) {
  const releasePr =
    (pulls.length > 0
      ? pulls.find((pull) =>
          pull.title.toLowerCase().includes(`release: ${releaseVersion}`),
        )
      : undefined) || pulls[0];

  if (!releasePr) {
    throw new Error(
      `No release PR found for release/${releaseVersion} in ${githubCodeRepo}`,
    );
  }
  if (releasePr.title.toLowerCase() !== `release: ${releaseVersion}`) {
    throw new Error(
      `Warning: The first PR found for release/${releaseVersion} in ${githubCodeRepo} (${releasePr.url}) does not have the expected title ("Release: ${releaseVersion}"). Its title is actually: "${releasePr.title}".`,
    );
  }

  return releasePr;
}

/**
 * Last `metamaskbot` comment that contains "Builds ready", within the
 * comments the caller already limited to the latest 50.
 *
 * @param {object[]} comments - `{ body, url, author: { login } }`.
 * @param {string} platform - `Extension` or `Mobile`.
 * @returns {{ latestBuildCommentUrl: string | undefined, latestBuildCommentDownloadUrls: object }} Build comment fields.
 */
export function latestBuildFromComments(comments, platform) {
  const metamaskBotBuildComments =
    comments?.filter(
      (comment) =>
        comment.author?.login === 'metamaskbot' &&
        comment.body.includes('Builds ready'),
    ) || [];
  const latestBuildComment =
    metamaskBotBuildComments.length > 0
      ? metamaskBotBuildComments[metamaskBotBuildComments.length - 1]
      : undefined;
  const latestBuildCommentDownloadUrls = latestBuildComment
    ? extractDownloadUrls(latestBuildComment.body, platform)
    : {};

  return {
    latestBuildCommentUrl: latestBuildComment?.url,
    latestBuildCommentDownloadUrls,
  };
}
