/**
 * Copies an environment without the LiteLLM credential. Child processes other
 * than the clean-room cleaner must never see it.
 *
 * @param environment - The environment to copy. Defaults to the current one.
 * @returns The copy, without `AI_ANALYZER_LITELLM_KEY`.
 */
export function getEnvironmentWithoutAiKey(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const scrubbedEnvironment = { ...environment };
  delete scrubbedEnvironment.AI_ANALYZER_LITELLM_KEY;
  return scrubbedEnvironment;
}
