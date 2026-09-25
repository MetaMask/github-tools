You are reviewing a generated MetaMask changelog section before release.

Your task is to rewrite and recategorize only the release section provided
below. Inspect the matching pull requests and relevant repository changes when
needed to understand an entry. Return the complete corrected release section
in Markdown, including its `## [VERSION]` heading and all `###` category
headings. Do not include analysis, explanations, a diff, or any text outside
the corrected Markdown.

## Goals

1. Remove the `### Uncategorized` section entirely.
2. Put every retained entry in exactly one appropriate Keep a Changelog
   category. Include a category heading only when it contains at least one
   entry:
   - Added: new user-visible functionality
   - Changed: changed behavior, UI, flows, dependencies, or configuration
   - Deprecated: functionality marked deprecated
   - Removed: functionality removed
   - Fixed: user-facing bug fixes
   - Security: security fixes or improvements
3. Use concise, user-facing, past-tense wording.
4. Preserve every distinct input PR number exactly once, in the existing
   `(#12345)` form. If a generator defect repeats the same PR reference,
   retain it once. A consolidated entry may contain multiple trailing PR
   references.
5. Do not add, remove, or invent distinct PR numbers. Do not split a PR into
   multiple entries.
6. Do not add information not supported by the entry text, its matching PR,
   or the relevant repository changes.
7. Preserve existing valid entries unless a correction is required.
8. Before returning, perform a PR-reference inventory audit. Every distinct
   input `(#12345)` reference must appear exactly once in the output. Compare
   the unique reference sets to ensure none is omitted or invented, then count
   output occurrences to ensure no reference was duplicated while moving or
   consolidating entries. A consolidated entry must retain every source PR
   reference. Do not omit a reference because its authored entry is `null`,
   because it is a dependency or internal change, or because it is paired with
   a release-automation cherry-pick. This is a blocking completion check: do
   not return output until every input reference has a destination entry.

## Writing rules

- Prefer simple past tense: `Added`, `Updated`, `Changed`, `Removed`,
  `Fixed`, `Improved`, `Enabled`.
- Use `non-EVM`, not `non EVM` or `Non-EVM`, unless it starts a proper name.
- Use American English: `behavior`, not `behaviour`.
- Do not expose implementation-only identifiers, constants, controller names,
  package names, internal flags, or internal APIs unless needed for clarity.
  Examples to rewrite:
  - `PASSWORD_MIN_LENGTH` -> `the confirmation password is long enough`
  - `QuoteMetadata` -> `quote metadata`, unless the type name is essential
  - `TextFieldSearch` -> `the updated search field`, unless it is
    user-facing terminology
- Do not use vague fragments such as `UI updates`, `Assets unify balance and
  traces`, `Local bridge activity label`, or `Bump controller`.
- Treat the supplied PR title as evidence for the matching trailing PR
  reference. It can clarify a vague generated entry, but it is not permission
  to infer functionality beyond what the title states.
- Do not turn a changelog entry into a guess. If the entry and PR title are
  both too vague to safely improve, retain their meaning with minimal
  grammatical cleanup.
- When rewriting an entry, retain concrete user-relevant behavior from the
  source, including conditions, affected surfaces, and observable outcomes.
  Simplify wording, but do not remove specific details merely for brevity
  unless the PR or repository evidence shows they are inaccurate or redundant.
- A dependency bump that fixes a user-visible issue should be described by
  the user-visible result where that result is clear.
- Do not claim a user-visible result from a dependency bump, feature-flag
  plumbing, or internal refactor unless the PR description or relevant diff
  explicitly establishes that result. Otherwise, describe the scoped update
  conservatively.
- Preserve the distinction between enabling a rollout capability and enabling
  the rollout itself. Do not say that a feature was enabled, retired, or
  removed when the evidence only adds a feature flag or support for doing so.
- Correct obvious typographical errors, but do not expand a vague entry into a
  specific user-facing claim without supporting evidence.
- Keep internal analytics, telemetry, and test-only changes only when they are
  already present in the generated section. Put them in `Changed` unless
  they clearly belong in another category. Describe them accurately and
  conservatively; do not present them as a product improvement or as a bug
  fix unless the PR establishes a user-facing defect.
- Remove internal rollout, experiment-treatment, implementation, and service
  names when the supported behavior can be stated without them. For example,
  write `Reduced unnecessary requests during wallet unlock`, not `Reduced
  requests for the treatment discovery layout`. Retain a rollout distinction
  only when it is necessary to avoid incorrectly claiming that a feature was
  enabled for users.
- Do not include Markdown links inside entry descriptions. Preserve only the
  trailing PR reference.
- When several entries have the same generated description and their PR
  titles show they are coordinated variants of one release-wide change,
  consolidate them into one concise user-facing entry. Include every affected
  PR reference in one trailing parenthesized list, in ascending numeric order
  (for example, `(#12345, #12346)`).
- Do not consolidate entries merely because their wording is similar. Keep
  distinct user-facing changes separate.
- A raw release-automation subject such as `Cherry-picking commits ... for PR
  #12345 (#12345)` is still a distinct input PR reference. Resolve its
  original PR to improve the wording, but retain that exact trailing PR
  reference in the output; do not substitute a different PR merely because it
  is also a release-automation or related change.

## Research rules

- For an unclear, overly technical, generic, or potentially duplicate entry,
  look up the matching PR from its trailing `(#12345)` reference before
  rewriting it. Read the PR title, description, and changed-file summary;
  inspect the relevant diff when that is necessary to describe the
  user-visible effect accurately.
- Use the repository and PR information only to clarify the entry, assign its
  category, or identify a coordinated release-wide change. Do not turn a
  minor implementation change into an unsupported feature claim.
- Do not include research notes, source paths, PR titles, links, or commit
  hashes in the result. Output only the corrected changelog section.
- If `pr_titles` or `pr_evidence` is provided, treat it as an index to
  prioritize research, not as a substitute for inspecting the matching PR when
  the available evidence does not answer the question.

## Input

<release_section>
PASTE THE GENERATED `## [VERSION]` SECTION HERE
</release_section>

<pr_titles>
OPTIONAL: PASTE ONE `#PR_NUMBER: TITLE` LINE FOR EACH PR IN THE RELEASE
SECTION HERE
</pr_titles>

<pr_evidence>
OPTIONAL: PASTE BOUNDED PR BODY AND CHANGED-FILE EVIDENCE HERE
</pr_evidence>
