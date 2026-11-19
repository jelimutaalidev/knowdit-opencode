/**
 * Version of the whole Phase 1 knowledge pipeline: prompt text, prompt
 * construction, response validation, and render rules. Bump on any change
 * that can alter persisted KG content or the shape of a model response.
 *
 * It feeds both the response-cache key and the journal fingerprint, so an
 * old build cannot be resumed or reused as if it had run under the new
 * contract.
 */
export const PIPELINE_VERSION = "2026-11-19.p0p1.4";
