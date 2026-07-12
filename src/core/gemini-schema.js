/**
 * src/core/gemini-schema.js
 *
 * Converts the plain JSON-Schema-style definitions used throughout this repo
 * (type: "object" | "string" | "array" | ..., properties, required) into the
 * Type-enum-based shape Gemini's `responseSchema` expects. Keeping schema
 * definitions in familiar JSON-Schema syntax everywhere else means agent.js
 * files stay readable and only the Gemini call site needs to convert.
 */
import { Type } from "@google/genai";

const TYPE_MAP = {
  object: Type.OBJECT,
  string: Type.STRING,
  array: Type.ARRAY,
  boolean: Type.BOOLEAN,
  number: Type.NUMBER,
  integer: Type.INTEGER,
};

/** Recursively convert a JSON-Schema-style definition to Gemini's responseSchema format. */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  const out = {};
  if (schema.type) out.type = TYPE_MAP[schema.type] ?? schema.type;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.items) out.items = toGeminiSchema(schema.items);

  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = toGeminiSchema(value);
    }
    // Gemini uses propertyOrdering (not object key order) to fix output field order.
    out.propertyOrdering = Object.keys(schema.properties);
  }
  if (schema.required) out.required = schema.required;
  // Gemini's schema has no additionalProperties knob — intentionally dropped.

  return out;
}
