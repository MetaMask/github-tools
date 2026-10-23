// Child processes other than the clean-room cleaner must never see the
// LiteLLM credential.
export function getEnvironmentWithoutAiKey(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const scrubbedEnvironment = { ...environment };
  delete scrubbedEnvironment.AI_ANALYZER_LITELLM_KEY;
  return scrubbedEnvironment;
}
