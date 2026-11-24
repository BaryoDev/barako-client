// A JSON Schema (draft 2020-12) for the `data` of an entry of one content type, built from the type's
// fields as GET /api/contents/types/{name} lists them.
//
// The schema describes. It does not validate: core checks every value on write, and its answer on a dry
// run stays the authority. Each fragment below follows what core 5.9.0 accepts for that field type
// (FieldTypeRegistry and the checks beside it). Where JSON Schema cannot say a rule, the fragment leaves
// it out and a fixed sentence says it in `description`.
//
// Field names, option values, default values and declared schemas come from the CMS. Every object keyed
// by one of those strings is built with Object.fromEntries, so a name such as `__proto__` stays an own
// key and never reaches a prototype.
import type { ReadableContentType, ReadableField } from "@baryodev/barako-client";

export type Schema = Record<string, unknown>;

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Core's canonical field types, in the order its registry declares them. */
const CANONICAL_TYPES = [
  "string", "text", "int", "bool", "datetime", "date", "decimal", "array", "object",
  "email", "url", "slug", "uuid", "richtext", "markdown", "time", "json", "money",
  "reference", "geopoint", "choice", "token", "file", "blocks", "inlineimage",
] as const;

/** The other names core accepts for a type. */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ["integer", "int"],
  ["number", "int"],
  ["boolean", "bool"],
]);

/** Every field type name this CLI can describe: the canonical names and the aliases. */
export const KNOWN_FIELD_TYPES: readonly string[] = [...CANONICAL_TYPES, ...ALIASES.keys()];

/** The item types an array field may declare. */
const ARRAY_ITEM_TYPES = [
  "string", "text", "markdown", "int", "decimal", "bool", "date", "datetime", "time",
  "email", "url", "slug", "uuid",
];

const GUID_ANY_CASE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const GUID_LOWER = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

// Limits from core's InlineImageFields: 64 KB of image bytes, base64 encoded, after the longest prefix.
const INLINE_IMAGE_MAX_URL = Math.floor((64 * 1024 + 2) / 3) * 4 + "data:image/jpeg;base64,".length;

const UNKNOWN_TYPE_NOTE =
  "This version of the barako CLI does not know this field type. The API checks the value.";
const TOP_NOTE =
  "The data of one entry. The API matches field names ignoring case and checks every value, so this schema describes and does not replace that check.";

interface Context {
  field: ReadableField;
}

type Builder = (ctx: Context) => Schema;

const plain =
  (fragment: Schema): Builder =>
  () => ({ ...fragment });

const BUILDERS: ReadonlyMap<string, Builder> = new Map<string, Builder>([
  ["string", plain({ type: "string" })],
  ["text", plain({ type: "string" })],
  ["richtext", plain({ type: "string" })],
  ["markdown", plain({ type: "string" })],
  [
    "int",
    plain({ type: ["integer", "string"], description: "A whole number that fits 64 bits, or text holding one." }),
  ],
  [
    "bool",
    plain({ type: ["boolean", "string"], description: "true or false, or the text \"true\" or \"false\"." }),
  ],
  ["datetime", plain({ type: "string", description: "A date and time as text, such as 2026-11-24T10:00:00Z." })],
  ["date", plain({ type: "string", description: "A date as text, such as 2026-11-24." })],
  ["decimal", plain({ type: ["number", "string"], description: "A number, or text holding one." })],
  [
    "money",
    ({ field }) =>
      typeof field.currency === "string" && field.currency !== ""
        ? {
            type: "number",
            description:
              "An amount as a JSON number, never text, in the currency the field declares, with no more decimal places than that currency allows. The API does not round it.",
          }
        : { type: ["number", "string"], description: "An amount, as a number or text holding one." },
  ],
  ["array", ({ field }) => arrayFragment(field)],
  ["object", plain({ type: "object" })],
  [
    "email",
    plain({
      type: "string",
      maxLength: 254,
      description: "A bare address with no display name, angle brackets, quotes or spaces.",
    }),
  ],
  ["url", plain({ type: "string", pattern: "^[Hh][Tt][Tt][Pp][Ss]?:", description: "An absolute http or https URL." })],
  ["slug", plain({ type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" })],
  ["uuid", plain({ type: "string", description: "A UUID as text." })],
  ["time", plain({ type: "string", description: "A time of day as text, such as 14:30 or 14:30:00." })],
  ["json", ({ field }) => jsonFragment(field)],
  ["reference", ({ field }) => referenceFragment(field)],
  [
    "geopoint",
    plain({
      type: "object",
      properties: {
        lat: { type: "number", minimum: -90, maximum: 90 },
        lng: { type: "number", minimum: -180, maximum: 180 },
      },
      required: ["lat", "lng"],
      description: "A position as JSON numbers under lat and lng. Text is refused.",
    }),
  ],
  ["choice", ({ field }) => choiceFragment(field)],
  ["token", plain({ type: "string", description: "A random string the server generates. A value sent is dropped." })],
  [
    "file",
    plain({
      type: "string",
      pattern: GUID_ANY_CASE,
      description: "The id of one stored file the caller may use. The API checks that it exists.",
    }),
  ],
  [
    "blocks",
    plain({
      type: "array",
      maxItems: 200,
      items: { type: "object", properties: { type: { type: "string", minLength: 1 } }, required: ["type"] },
      description: "A list of blocks, each an object naming its type. The API checks each block against the tenant's block schema.",
    }),
  ],
  [
    "inlineimage",
    plain({
      type: "object",
      properties: {
        url: { type: "string", maxLength: INLINE_IMAGE_MAX_URL, pattern: "^data:image/(png|jpeg|gif|webp);base64," },
        alt: { type: ["string", "null"], maxLength: 500 },
      },
      required: ["url"],
      additionalProperties: false,
      description:
        "A PNG, JPEG, GIF or WebP image of at most 64 KB and 2048 by 2048 pixels, as a base64 data URI under url.",
    }),
  ],
]);

function arrayFragment(field: ReadableField): Schema {
  const out: Schema = { type: "array" };
  const itemType = typeof field.itemType === "string" ? field.itemType : undefined;
  if (itemType !== undefined && ARRAY_ITEM_TYPES.includes(itemType)) {
    const build = BUILDERS.get(itemType);
    // An item is a bare value, so it carries no field of its own.
    if (build) out.items = build({ field: { ...field, type: itemType, currency: null, itemType: null } });
  }
  return out;
}

function jsonFragment(field: ReadableField): Schema {
  if (isObject(field.jsonSchema)) return copyJson(field.jsonSchema) as Schema;
  return { type: ["object", "array"] };
}

function referenceFragment(field: ReadableField): Schema {
  const target = typeof field.referenceType === "string" && field.referenceType !== "" ? { "x-referenceType": field.referenceType } : {};
  if (field.multiple) {
    return {
      type: "array",
      items: { type: "string", pattern: GUID_LOWER },
      uniqueItems: true,
      maxItems: 100,
      ...(field.isRequired ? { minItems: 1 } : {}),
      description: "A list of entry ids in lower case with hyphens, even of one. The API checks that each exists.",
      ...target,
    };
  }
  return { type: "string", description: "The id of an entry. The API checks that it exists.", ...target };
}

function choiceFragment(field: ReadableField): Schema {
  const values = optionValues(field.options);
  if (field.multiple) {
    return {
      type: "array",
      items: { type: "string", enum: values },
      uniqueItems: true,
      ...(field.isRequired ? { minItems: 1 } : {}),
      description: "A list of options, even of one.",
    };
  }
  return { type: "string", enum: values };
}

function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  for (const option of options) {
    const value = isObject(option) ? (option as { value?: unknown }).value : undefined;
    if (typeof value === "string") seen.add(value);
  }
  return [...seen];
}

/** Lets a fragment accept null as well. Core skips a null value on a field that is not required. */
function orNull(fragment: Schema): Schema {
  const type = fragment.type;
  if (typeof type === "string" || Array.isArray(type)) {
    const types = Array.isArray(type) ? type : [type];
    const out: Schema = { ...fragment, type: types.includes("null") ? types : [...types, "null"] };
    if (Array.isArray(fragment.enum) && !fragment.enum.includes(null)) out.enum = [...fragment.enum, null];
    return out;
  }
  if (Object.keys(fragment).length === 0) return fragment;
  return { anyOf: [fragment, { type: "null" }] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A deep copy that keeps a key such as `__proto__` as own data. */
function copyJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyJson);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyJson(v)]));
  return value;
}

function isComputed(field: ReadableField): boolean {
  return field.computed !== undefined && field.computed !== null;
}

function fragmentOf(field: ReadableField): Schema {
  const type = String(field.type ?? "").toLowerCase();
  const canonical = ALIASES.get(type) ?? type;
  const build = BUILDERS.get(canonical);
  const serverSets = isComputed(field) || canonical === "token";
  let out: Schema = build ? build({ field }) : { description: UNKNOWN_TYPE_NOTE };
  // An unknown type accepts anything already, null included. A schema the field declares may hold
  // keywords that apply to null too (const, allOf, $ref), so it is wrapped rather than widened.
  const declared = canonical === "json" && isObject(field.jsonSchema);
  if (build && !serverSets && !field.isRequired) out = declared ? { anyOf: [out, { type: "null" }] } : orNull(out);
  if (serverSets) out.readOnly = true;
  if (field.defaultValue !== undefined && field.defaultValue !== null) out.default = copyJson(field.defaultValue);
  if (isObject(field.validationRules) && Object.keys(field.validationRules).length > 0) {
    out["x-validationRules"] = copyJson(field.validationRules);
  }
  if (canonical === "blocks" && typeof field.blockSchema === "string" && field.blockSchema !== "") {
    out["x-blockSchema"] = field.blockSchema;
  }
  return out;
}

/** The JSON Schema for the `data` of an entry of this type. */
export function dataSchemaOf(type: ReadableContentType): Schema {
  const fields = (Array.isArray(type?.fields) ? type.fields : []).filter(
    (f): f is ReadableField => isObject(f) && typeof f.name === "string" && f.name !== "",
  );
  const required = fields
    .filter((f) => f.isRequired === true && !isComputed(f) && String(f.type ?? "").toLowerCase() !== "token")
    .map((f) => f.name);
  return {
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
    description: TOP_NOTE,
    properties: Object.fromEntries(fields.map((f) => [f.name, fragmentOf(f)])),
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
