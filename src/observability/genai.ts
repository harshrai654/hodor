/**
 * GenAI span attribute names from the OpenTelemetry GenAI semantic conventions.
 *
 * `@opentelemetry/semantic-conventions` still exports these as `ATTR_GEN_AI_*`,
 * but marks every one deprecated: the registry moved to
 * https://github.com/open-telemetry/semantic-conventions-genai, which does not
 * publish a JavaScript package. The attribute strings are unchanged.
 */
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS =
  "gen_ai.usage.cache_read.input_tokens";
export const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS =
  "gen_ai.usage.cache_creation.input_tokens";
