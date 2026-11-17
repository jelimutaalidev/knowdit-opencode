export class JsonTruncatedError extends Error {
  constructor(message = "model response ended before the JSON object was complete") {
    super(message);
    this.name = "JsonTruncatedError";
  }
}

/**
 * Pull the first complete JSON object out of a model response.
 *
 * Handles bare objects and ```json fences, ignores prose around the object,
 * and distinguishes truncation (unbalanced braces) from malformed JSON so the
 * caller can report the right retry reason.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;

  const start = body.indexOf("{");
  if (start === -1) {
    throw new JsonTruncatedError("model response did not contain a JSON object");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < body.length; i++) {
    const char = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) throw new JsonTruncatedError();
  return JSON.parse(body.slice(start, end + 1));
}
