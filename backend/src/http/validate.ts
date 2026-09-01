/**
 * Request-body validation, dependency-free.
 *
 * Bodies used to be *typed* and nothing more: `await req.json<{ email: string }>()`
 * asserts a shape at compile time and checks nothing at run time. So a malformed
 * body did not fail at the edge — it travelled until something downstream tripped
 * over it, and the two ways that ended were both wrong:
 *
 *  - malformed JSON threw a SyntaxError out of `req.json()`, which the router
 *    correctly treats as a bug and answers with **500 internal error** — a
 *    server error reported for a client mistake, and noise in anything alerting
 *    on 5xx;
 *  - a well-formed body with the wrong types reached the domain, where SOME
 *    fields are checked and some are not.
 *
 * This module is the missing edge: `readBody` parses once, rejects anything that
 * does not match the declared shape with a `BAD_REQUEST` DomainError, and the
 * router renders that as a 400 carrying a message written for a parent.
 *
 * It is deliberately tiny — the repo has zero runtime dependencies and that is
 * not negotiable, so this is not Zod and does not try to be. It covers the
 * shapes this API actually accepts. Unknown keys are IGNORED rather than
 * rejected, so an older backend never refuses a newer client's request over a
 * field it does not read yet.
 */
import { DomainError } from "../domain/services.js";
import type { HttpRequest } from "./router.js";

const bad = (message: string) => new DomainError(message, "BAD_REQUEST");

/** A parser turns unknown input into `T` or throws a parent-readable refusal.
 *  `optional` marks fields whose absence is not itself an error. */
export type Parser<T> = ((value: unknown, label: string) => T) & { optional?: boolean };

/** Absent (or explicitly null) passes through as `undefined`. */
export function optional<T>(inner: Parser<T>): Parser<T | undefined> {
  const p: Parser<T | undefined> = (v, label) => (v === undefined || v === null ? undefined : inner(v, label));
  p.optional = true;
  return p;
}

/** Absent falls back to `fallback`, so a handler never sees `undefined`. */
export function withDefault<T>(inner: Parser<T>, fallback: T): Parser<T> {
  const p: Parser<T> = (v, label) => (v === undefined || v === null ? fallback : inner(v, label));
  p.optional = true;
  return p;
}

export function str(opts: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {}): Parser<string> {
  const { min = 1, max = 4096, pattern, trim = true } = opts;
  return (v, label) => {
    if (typeof v !== "string") throw bad(`${label} must be text`);
    const s = trim ? v.trim() : v;
    if (s.length < min) throw bad(min <= 1 ? `${label} is required` : `${label} must be at least ${min} characters`);
    if (s.length > max) throw bad(`${label} is too long (${max} characters at most)`);
    if (pattern && !pattern.test(s)) throw bad(`${label} contains something we cannot use`);
    return s;
  };
}

/** Structural only — deliverability is never claimed (see looksLikeEmail). */
export function email(): Parser<string> {
  return (v, label) => {
    const s = str({ max: 254 })(v, label);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad(`${label} does not look like an email address`);
    return s;
  };
}

export function oneOf<const T extends readonly string[]>(values: T): Parser<T[number]> {
  return (v, label) => {
    if (typeof v !== "string" || !values.includes(v)) throw bad(`${label} must be one of: ${values.join(", ")}`);
    return v as T[number];
  };
}

export function int(opts: { min?: number; max?: number } = {}): Parser<number> {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts;
  return (v, label) => {
    if (typeof v !== "number" || !Number.isInteger(v)) throw bad(`${label} must be a whole number`);
    if (v < min || v > max) throw bad(`${label} must be between ${min} and ${max}`);
    return v;
  };
}

export function arrayOf<T>(item: Parser<T>, opts: { max?: number } = {}): Parser<T[]> {
  const { max } = opts;
  return (v, label) => {
    if (!Array.isArray(v)) throw bad(`${label} must be a list`);
    if (max !== undefined && v.length > max) throw bad(`${label} has too many entries (${max} at most)`);
    return v.map((entry) => item(entry, `each entry in ${label}`));
  };
}

/** An object used as a map: arbitrary keys, one parser for every value. */
export function dict<T>(value: Parser<T>, opts: { keyPattern?: RegExp } = {}): Parser<Record<string, T>> {
  return (v, label) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad(`${label} must be a set of named values`);
    const out: Record<string, T> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (opts.keyPattern && !opts.keyPattern.test(k)) throw bad(`${label} has a name we cannot use: ${k.slice(0, 40)}`);
      out[k] = value(val, `${k} in ${label}`);
    }
    return out;
  };
}

type Shape = Record<string, Parser<unknown>>;
type Infer<S extends Shape> = { [K in keyof S]: S[K] extends Parser<infer T> ? T : never };

/**
 * An object with a declared shape. `labels` renames a field for the message a
 * parent reads — copy in this product is written for parents, and "displayName
 * must be text" is not. Absent from `labels` means the field name is already
 * something a person would recognise (or the caller is a device, not a person).
 */
export function object<S extends Shape>(shape: S, labels: Partial<Record<keyof S, string>> = {}): Parser<Infer<S>> {
  return (v, label) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad(`${label} must be a set of values`);
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, parser] of Object.entries(shape)) {
      const fieldLabel = labels[key as keyof S] ?? key;
      const raw = src[key];
      if (raw === undefined || raw === null) {
        if (!parser.optional) throw bad(`${fieldLabel} is required`);
        out[key] = parser(raw, fieldLabel);
        continue;
      }
      out[key] = parser(raw, fieldLabel);
    }
    return out as Infer<S>;
  };
}

/** First branch that matches wins; if none do, the caller sees `message`. */
export function union<T>(branches: Array<Parser<T>>, message: string): Parser<T> {
  return (v, label) => {
    for (const branch of branches) {
      try { return branch(v, label); } catch { /* try the next shape */ }
    }
    throw bad(message);
  };
}

/**
 * Read and validate a request body. The ONLY way a handler should touch
 * `req.json()`: it turns both failure modes (unreadable JSON, wrong shape) into
 * one 400 with a message a parent can act on, instead of a 500 or a surprise
 * further in.
 */
export async function readBody<T>(req: HttpRequest, parser: Parser<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw bad("we could not read that request — it was not valid JSON");
  }
  return parser(raw, "the request");
}
