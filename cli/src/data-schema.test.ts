import { describe, expect, it } from "vitest";
import type { ReadableContentType, ReadableField } from "@baryodev/barako-client";
import { KNOWN_FIELD_TYPES, dataSchemaOf } from "./data-schema";

function field(over: Partial<ReadableField> & { name: string; type: string }): ReadableField {
  return { isRequired: false, validationRules: {}, multiple: false, ...over };
}

function typeOf(...fields: ReadableField[]): ReadableContentType {
  return { name: "t", displayName: "T", description: "", isSingleton: false, fields };
}

/** The fragment of one optional field. Its null twin is checked on its own, so it is removed here. */
function required(f: Partial<ReadableField> & { type: string }): any {
  const schema = dataSchemaOf(typeOf(field({ name: "f", isRequired: true, ...f }))) as any;
  return schema.properties.f;
}

function optional(f: Partial<ReadableField> & { type: string }): any {
  const schema = dataSchemaOf(typeOf(field({ name: "f", ...f }))) as any;
  return schema.properties.f;
}

const CORE_5_9_0 = [
  "string", "text", "int", "bool", "datetime", "date", "decimal", "array", "object", "email", "url", "slug",
  "uuid", "richtext", "markdown", "time", "json", "money", "reference", "geopoint", "choice", "token", "file",
  "blocks", "inlineimage", "integer", "number", "boolean",
];

describe("KNOWN_FIELD_TYPES", () => {
  it("equals the core 5.9.0 list: 25 canonical types and 3 aliases", () => {
    expect([...KNOWN_FIELD_TYPES].sort()).toEqual([...CORE_5_9_0].sort());
  });

  it("every known type has a fragment that is not the unknown-type note", () => {
    for (const type of KNOWN_FIELD_TYPES) {
      const f = required({ type });
      expect(JSON.stringify(f), type).not.toContain("does not know");
    }
  });
});

describe("one fragment per canonical type", () => {
  it("string, text, richtext, markdown are strings", () => {
    for (const type of ["string", "text", "richtext", "markdown"]) expect(required({ type })).toEqual({ type: "string" });
  });

  it("int takes a whole number or text holding one", () => {
    expect(required({ type: "int" }).type).toEqual(["integer", "string"]);
  });

  it("bool takes a boolean or its text", () => {
    expect(required({ type: "bool" }).type).toEqual(["boolean", "string"]);
  });

  it("datetime, date and time are text", () => {
    for (const type of ["datetime", "date", "time", "uuid"]) expect(required({ type }).type, type).toBe("string");
  });

  it("decimal takes a number or text holding one", () => {
    expect(required({ type: "decimal" }).type).toEqual(["number", "string"]);
  });

  it("array is an array, with items when itemType is declared", () => {
    expect(required({ type: "array" })).toEqual({ type: "array" });
    const items = required({ type: "array", itemType: "int" }).items;
    expect(items.type).toEqual(["integer", "string"]);
    expect(required({ type: "array", itemType: "email" }).items.maxLength).toBe(254);
  });

  it("array ignores multiple and an itemType core does not allow", () => {
    expect(required({ type: "array", multiple: true })).toEqual({ type: "array" });
    expect(required({ type: "array", itemType: "reference" })).toEqual({ type: "array" });
  });

  it("object is an object", () => {
    expect(required({ type: "object" })).toEqual({ type: "object" });
  });

  it("email is a string of at most 254 characters", () => {
    const f = required({ type: "email" });
    expect(f.type).toBe("string");
    expect(f.maxLength).toBe(254);
  });

  it("url starts with http or https", () => {
    const f = required({ type: "url" });
    expect(new RegExp(f.pattern).test("https://example.com")).toBe(true);
    expect(new RegExp(f.pattern).test("HTTP://example.com")).toBe(true);
    expect(new RegExp(f.pattern).test("ftp://example.com")).toBe(false);
  });

  it("slug is lower case words joined by hyphens", () => {
    const re = new RegExp(required({ type: "slug" }).pattern);
    expect(re.test("a-b-1")).toBe(true);
    expect(re.test("A-b")).toBe(false);
    expect(re.test("a--b")).toBe(false);
  });

  it("json is an object or an array", () => {
    expect(required({ type: "json" }).type).toEqual(["object", "array"]);
  });

  it("money with a currency takes a number only, without one a number or text", () => {
    expect(required({ type: "money", currency: "USD" }).type).toBe("number");
    expect(required({ type: "money" }).type).toEqual(["number", "string"]);
  });

  it("reference is an id string and keeps its target", () => {
    const f = required({ type: "reference", referenceType: "author" });
    expect(f.type).toBe("string");
    expect(f["x-referenceType"]).toBe("author");
  });

  it("geopoint is lat and lng numbers in range", () => {
    const f = required({ type: "geopoint" });
    expect(f.type).toBe("object");
    expect(f.required).toEqual(["lat", "lng"]);
    expect(f.properties.lat).toEqual({ type: "number", minimum: -90, maximum: 90 });
    expect(f.properties.lng).toEqual({ type: "number", minimum: -180, maximum: 180 });
  });

  it("choice is one of its options", () => {
    const f = required({ type: "choice", options: [{ value: "a", label: "A" }, { value: "b", label: "" }] });
    expect(f).toEqual({ type: "string", enum: ["a", "b"] });
  });

  it("token is a read only string", () => {
    const f = optional({ type: "token" });
    expect(f.type).toBe("string");
    expect(f.readOnly).toBe(true);
  });

  it("file is the id of a stored file", () => {
    const f = required({ type: "file" });
    const re = new RegExp(f.pattern);
    expect(re.test("0b8f0f4e-1111-4222-8333-444455556666")).toBe(true);
    // Core reads it with Guid.TryParseExact(value, "D"), which takes either case.
    expect(re.test("0B8F0F4E-1111-4222-8333-444455556666")).toBe(true);
    expect(re.test("not an id")).toBe(false);
  });

  it("blocks is a list of objects with a string type", () => {
    const f = required({ type: "blocks" });
    expect(f.type).toBe("array");
    expect(f.maxItems).toBe(200);
    expect(f.items.required).toEqual(["type"]);
    expect(f.items.properties.type).toEqual({ type: "string", minLength: 1 });
  });

  it("inlineimage is a data URI object with url and optional alt and no other member", () => {
    const f = required({ type: "inlineimage" });
    expect(f.required).toEqual(["url"]);
    expect(f.additionalProperties).toBe(false);
    expect(new RegExp(f.properties.url.pattern).test("data:image/png;base64,AAAA")).toBe(true);
    expect(new RegExp(f.properties.url.pattern).test("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(f.properties.url.maxLength).toBe(87407);
    expect(f.properties.alt).toEqual({ type: ["string", "null"], maxLength: 500 });
  });
});

describe("one fragment per alias", () => {
  it("integer and number are int", () => {
    expect(required({ type: "integer" })).toEqual(required({ type: "int" }));
    expect(required({ type: "number" })).toEqual(required({ type: "int" }));
  });

  it("boolean is bool", () => {
    expect(required({ type: "boolean" })).toEqual(required({ type: "bool" }));
  });

  it("a type name is read ignoring case", () => {
    expect(required({ type: "Boolean" })).toEqual(required({ type: "bool" }));
    expect(required({ type: "EMAIL" })).toEqual(required({ type: "email" }));
  });
});

describe("per field settings", () => {
  it("lists required fields, and leaves out computed and token fields", () => {
    const schema = dataSchemaOf(
      typeOf(
        field({ name: "a", type: "string", isRequired: true }),
        field({ name: "b", type: "string" }),
        field({ name: "c", type: "decimal", isRequired: true, computed: { fn: "add", args: ["a"] } }),
        field({ name: "d", type: "token", isRequired: true }),
      ),
    ) as any;
    expect(schema.required).toEqual(["a"]);
  });

  it("has no required key when nothing is required", () => {
    expect(dataSchemaOf(typeOf(field({ name: "a", type: "string" })))).not.toHaveProperty("required");
  });

  it("marks computed and token fields read only", () => {
    const schema = dataSchemaOf(
      typeOf(field({ name: "c", type: "decimal", computed: { fn: "add", args: [] } }), field({ name: "t", type: "token" })),
    ) as any;
    expect(schema.properties.c.readOnly).toBe(true);
    expect(schema.properties.t.readOnly).toBe(true);
    expect(schema.properties.c.type).toEqual(["number", "string"]);
  });

  it("copies the default value", () => {
    expect(optional({ type: "string", defaultValue: "x" }).default).toBe("x");
    expect(optional({ type: "bool", defaultValue: false }).default).toBe(false);
    expect(optional({ type: "string" })).not.toHaveProperty("default");
  });

  it("a required field with a default stays required and says only create fills it", () => {
    const note = "Create fills this from its default when it is left out. Update does not, so an update must send it.";
    const schema = dataSchemaOf(typeOf(field({ name: "A", type: "string", isRequired: true, defaultValue: "x" }))) as any;
    expect(schema.required).toEqual(["A"]);
    expect(schema.properties.A.default).toBe("x");
    expect(schema.properties.A.description).toBe(note);
    expect(required({ type: "int", defaultValue: 3 }).description).toBe(`A whole number that fits 64 bits, or text holding one. ${note}`);
    expect(optional({ type: "string", defaultValue: "x" })).not.toHaveProperty("description");
    expect(required({ type: "token", defaultValue: "x" }).description).not.toContain("Create fills");
  });

  it("an optional field also takes null, a required one does not", () => {
    expect(optional({ type: "string" }).type).toEqual(["string", "null"]);
    expect(optional({ type: "int" }).type).toEqual(["integer", "string", "null"]);
    expect(required({ type: "string" }).type).toBe("string");
    const choice = optional({ type: "choice", options: [{ value: "a", label: "" }] });
    expect(choice.type).toEqual(["string", "null"]);
    expect(choice.enum).toEqual(["a", null]);
  });

  it("choice enum holds the option values once, strings only", () => {
    const f = required({ type: "choice", options: [{ value: "a" }, { value: "a" }, { value: 3 }, null, "x"] });
    expect(f.enum).toEqual(["a"]);
  });

  it("choice with no options accepts nothing", () => {
    expect(required({ type: "choice" }).enum).toEqual([]);
  });

  it("multiple choice is a list of the options without repeats", () => {
    const f = required({ type: "choice", multiple: true, options: [{ value: "a" }, { value: "b" }] });
    expect(f).toMatchObject({ type: "array", uniqueItems: true, minItems: 1, items: { type: "string", enum: ["a", "b"] } });
    expect(optional({ type: "choice", multiple: true, options: [] })).not.toHaveProperty("minItems");
  });

  it("multiple reference is a list of lower case ids, at most 100", () => {
    const f = required({ type: "reference", multiple: true, referenceType: "tag" });
    expect(f).toMatchObject({ type: "array", uniqueItems: true, maxItems: 100, minItems: 1, "x-referenceType": "tag" });
    expect(new RegExp(f.items.pattern).test("0b8f0f4e-1111-4222-8333-444455556666")).toBe(true);
    expect(new RegExp(f.items.pattern).test("0B8F0F4E-1111-4222-8333-444455556666")).toBe(false);
  });

  it("a multiple flag on other types changes nothing", () => {
    expect(required({ type: "string", multiple: true })).toEqual({ type: "string" });
    expect(required({ type: "file", multiple: true })).toEqual(required({ type: "file" }));
  });

  it("a declared jsonSchema is the fragment", () => {
    const declared = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
    const f = required({ type: "json", jsonSchema: declared });
    expect(f).toEqual(declared);
    expect(f).not.toBe(declared);
    expect(f.properties).not.toBe(declared.properties);
  });

  it("an optional json field with a declared schema also takes null", () => {
    const f = optional({ type: "json", jsonSchema: { type: "object" } });
    expect(f.anyOf).toEqual([{ type: "object" }, { type: "null" }]);
  });

  it("blocks keeps the block schema route under x-blockSchema", () => {
    expect(required({ type: "blocks", blockSchema: "/api/blocks/schema" })["x-blockSchema"]).toBe("/api/blocks/schema");
    expect(required({ type: "blocks" })).not.toHaveProperty("x-blockSchema");
  });

  it("copies validationRules under x-validationRules when not empty", () => {
    const rules = { minLength: 3, pattern: "^a" };
    const f = required({ type: "string", validationRules: rules });
    expect(f["x-validationRules"]).toEqual(rules);
    expect(f["x-validationRules"]).not.toBe(rules);
    expect(required({ type: "string" })).not.toHaveProperty("x-validationRules");
  });

  it("an unknown type is open, with a fixed note", () => {
    const f = required({ type: "hologram", options: [{ value: "x" }], validationRules: { a: 1 } });
    expect(f.description).toBe("This version of the barako CLI does not know this field type. The API checks the value.");
    expect(f.type).toBeUndefined();
    expect(f["x-validationRules"]).toEqual({ a: 1 });
    expect(optional({ type: "hologram" })).not.toHaveProperty("anyOf");
  });

  it("a type named like an Object.prototype member is unknown, not a crash", () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(required({ type }).description, type).toContain("does not know");
    }
  });
});

describe("top level", () => {
  it("has the 2020-12 dialect and type object, and allows keys it does not list", () => {
    const schema = dataSchemaOf(typeOf(field({ name: "a", type: "string" }))) as any;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
    // The route leaves out fields the caller may not read, and core accepts some of them on a write.
    expect(schema).not.toHaveProperty("additionalProperties");
    expect(Object.keys(schema.properties)).toEqual(["a"]);
    expect(schema.description).toContain("may not read is not listed");
    expect(schema.description).toContain("ignoring case");
  });

  it("an empty or odd field list gives an empty properties object", () => {
    expect((dataSchemaOf(typeOf()) as any).properties).toEqual({});
    expect((dataSchemaOf({ name: "x" } as unknown as ReadableContentType) as any).properties).toEqual({});
    const odd = [{ type: "string" }, { name: "", type: "string" }, { name: 7, type: "string" }, null, "Title"];
    const schema = dataSchemaOf({ name: "x", fields: odd } as unknown as ReadableContentType) as any;
    expect(schema.properties).toEqual({});
    expect(schema.required).toBeUndefined();
  });
});

describe("keys that come from the CMS", () => {
  it("a field named __proto__ or constructor is an own key of properties, and nothing is polluted", () => {
    const schema = dataSchemaOf(
      typeOf(
        field({ name: "__proto__", type: "string", isRequired: true }),
        field({ name: "constructor", type: "int" }),
        field({ name: "toString", type: "bool" }),
      ),
    ) as any;
    const own = Object.getOwnPropertyNames(schema.properties);
    expect(own).toContain("__proto__");
    expect(own).toContain("constructor");
    expect(own).toContain("toString");
    expect(Object.getPrototypeOf(schema.properties)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(schema.properties, "__proto__")!.value.type).toBe("string");
    expect(schema.required).toEqual(["__proto__"]);
    expect(({} as any).type).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(JSON.parse(JSON.stringify(schema)).properties.constructor.type).toEqual(["integer", "string", "null"]);
  });

  it("a declared jsonSchema holding __proto__ keeps it as data", () => {
    const declared = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"__proto__":{"polluted":true}}');
    const f = required({ type: "json", jsonSchema: declared });
    expect(Object.getOwnPropertyNames(f)).toContain("__proto__");
    expect(Object.getOwnPropertyNames(f.properties)).toContain("__proto__");
    expect(Object.getPrototypeOf(f)).toBe(Object.prototype);
    expect(f.polluted).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
  });

  it("a default value and validationRules holding __proto__ stay data", () => {
    const rules = JSON.parse('{"__proto__":{"x":1}}');
    const def = JSON.parse('{"__proto__":{"y":2}}');
    const f = required({ type: "object", validationRules: rules, defaultValue: def });
    expect(Object.getOwnPropertyNames(f["x-validationRules"])).toContain("__proto__");
    expect(Object.getOwnPropertyNames(f.default)).toContain("__proto__");
    expect(f.default.y).toBeUndefined();
    expect(({} as any).y).toBeUndefined();
  });

  it("an option value of __proto__ is a plain enum entry", () => {
    expect(required({ type: "choice", options: [{ value: "__proto__" }] }).enum).toEqual(["__proto__"]);
  });
});
