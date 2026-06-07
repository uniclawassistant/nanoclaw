/**
 * Recover MCP tool-call parameters that were smuggled inside another
 * parameter's string value as raw XML.
 *
 * Why this exists: the Claude Agent SDK / native binary sometimes emits a
 * tool-call where the model wrote `<prompt>…</prompt>` instead of
 * `<parameter name="prompt">…</parameter>`. The native parser doesn't see a
 * matching `</parameter>` and ends up concatenating the trailing
 * `<parameter name="X">VALUE` blocks into the first string parameter, so the
 * other arguments arrive as `undefined`. FED-32 (generate_image preset
 * ignored — always 1024x1024) is the symptom; the root cause is upstream.
 *
 * This normalizer is a single point of repair. For every tool registered via
 * `safeTool`, it inspects each incoming string field, detects the
 * `</WORD>\s*<parameter name="…">` boundary, slices it off the original field,
 * and recovers the embedded `<parameter name="…">VALUE` blocks into the
 * matching known-parameter slots — but only when those slots are still
 * undefined, never overwriting a legitimately-passed argument.
 */

const SMUGGLED_BOUNDARY = /<\/[a-zA-Z_][a-zA-Z0-9_-]*>\s*<parameter\s+name="/;

const PARAMETER_BLOCK =
  /<parameter\s+name="([^"]+)">([\s\S]*?)(?=<parameter\s+name=|<\/parameter>\s*$|<\/parameter>\s*<parameter|$)/g;

export interface NormalizeOptions {
  /** Parameter names declared in the tool's zod shape. */
  knownParams: ReadonlyArray<string>;
  /**
   * Subset of `knownParams` whose declared zod type is a string (after
   * unwrapping optional/nullable/default). Recovered values for these
   * parameters are returned verbatim — `caption="[1,2]"` stays the string
   * `[1,2]`, never gets `JSON.parse`'d into an array. Coercion is driven by
   * the declared type, not by the shape of the raw text.
   */
  stringParams?: ReadonlyArray<string>;
}

export interface NormalizationResult<T> {
  /** Args after stripping smuggled tails and merging recovered values. */
  args: T;
  /** Names of parameters recovered from smuggled XML (may be empty). */
  recovered: string[];
  /**
   * True if a boundary was detected but the tail contained no
   * <parameter name="…"> blocks that referenced any known parameter — i.e.
   * the smuggled content is not interpretable. Caller can refuse with an
   * explicit error to avoid silently defaulting.
   */
  unrecognized: boolean;
}

export function normalizeXmlSmuggledArgs<T extends Record<string, unknown>>(
  args: T,
  opts: NormalizeOptions,
): NormalizationResult<T> {
  const knownSet = new Set(opts.knownParams);
  const stringSet = new Set(opts.stringParams ?? []);
  const recovered = new Set<string>();
  let anyBoundary = false;
  let anyKnownParamSeen = false;
  const cleaned: Record<string, unknown> = { ...args };

  for (const [field, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue;
    const boundary = SMUGGLED_BOUNDARY.exec(value);
    if (!boundary) continue;
    anyBoundary = true;

    cleaned[field] = value.slice(0, boundary.index);
    const tail = value.slice(boundary.index);

    for (const [name, rawValue] of parseParameterBlocks(tail)) {
      if (!knownSet.has(name)) continue;
      anyKnownParamSeen = true;
      // Never clobber a value the caller did pass through.
      if (cleaned[name] !== undefined && cleaned[name] !== '') continue;
      cleaned[name] = stringSet.has(name)
        ? rawValue
        : coerceParameterValue(rawValue);
      recovered.add(name);
    }
  }

  return {
    args: cleaned as T,
    recovered: Array.from(recovered),
    // Refuse-worthy only when we saw an XML boundary and *no* tail block
    // even named a known parameter. Collisions (tail named a known param
    // already set by the caller) don't count as unrecognized — the call is
    // still well-formed at the API level.
    unrecognized: anyBoundary && !anyKnownParamSeen,
  };
}

function parseParameterBlocks(tail: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  PARAMETER_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PARAMETER_BLOCK.exec(tail)) !== null) {
    const name = match[1];
    let raw = match[2];
    raw = raw.replace(/<\/parameter>\s*$/, '').trim();
    if (!raw) continue;
    out.push([name, raw]);
  }
  return out;
}

/**
 * Coerce a recovered value for a non-string-typed parameter (array, number,
 * boolean, …). String-typed parameters bypass this and use the raw verbatim,
 * so a caption like `"[1,2]"` is never silently turned into an array.
 */
function coerceParameterValue(raw: string): unknown {
  const first = raw[0];
  if (
    first === '[' ||
    first === '{' ||
    first === '"' ||
    raw === 'true' ||
    raw === 'false' ||
    raw === 'null' ||
    /^-?\d+(\.\d+)?$/.test(raw)
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through to raw string
    }
  }
  return raw;
}
