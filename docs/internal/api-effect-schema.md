# Effect v4 (4.0.0-rc.113) — Schema cheat-sheet

Source of truth read: `node_modules/.pnpm/effect@4.0.0-rc.113/node_modules/effect/src/{Schema,SchemaAST,SchemaIssue,SchemaRepresentation,JsonSchema,Formatter,Struct}.ts`
and `ai-docs/src/01_effect/02_schema/`.

Everything below marked "compiled" was typechecked with
`npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck`
and most of it was also **executed** with `tsx`; the printed outputs shown are real.

## 0. Environment gotcha (do this first)

**STALE — corrected by the critic pass:** `effect` **is** now resolvable from the workspace root
(root `package.json` declares it; no hand-made symlinks are involved). Ignore the hand-symlink advice.
What remains true: **implementation agents must add `"effect": "4.0.0-rc.113"` as an explicit dependency of each
package that imports it** or resolution breaks again after any `pnpm install`.

Everything in this lane comes from the top-level module `"effect"`. There is **no**
`effect/unstable/schema` module for the core Schema API — `src/unstable/` has `ai/`, `http/`,
`rpc/`, `sql/`… but no `schema/`. `import { Schema } from "effect"`.

Relevant modules: `Schema`, `SchemaIssue`, `SchemaAST`, `SchemaGetter`,
`SchemaTransformation`, `SchemaRepresentation`, `JsonSchema`, `Formatter`, `StandardSchema`.

---

## 1. Big deltas from Effect v3 (read this before writing anything)

| v3 habit | v4 reality |
|---|---|
| `Schema.Schema<A, I, R>` | `Schema.Codec<T, E, RD, RE>`. Types live at `typeof S["Type"]` / `["Encoded"]`. `Schema.Schema<T>` is the one-param decode-only view. |
| `ParseResult.ParseError` | `Schema.SchemaError` (a `Data.TaggedError("SchemaError")` with `{ issue: SchemaIssue.Issue }`). `ParseError` does not exist. |
| `ParseResult.TreeFormatter.formatErrorSync` | `SchemaIssue.makeFormatterDefault()` / `SchemaIssue.makeFormatterStandardSchemaV1()` |
| `Schema.decodeUnknown(s)` returns Effect | Effect variant is **`Schema.decodeUnknownEffect`**. There is no bare `decodeUnknown`. |
| `Schema.filter` | `Schema.check(...)` + `Schema.makeFilter` / built-in `Schema.isXxx()` checks |
| `Schema.optional({ default })` | `Schema.optionalKey` / `Schema.optional` + `Schema.withDecodingDefaultKey` / `withDecodingDefault` / `withConstructorDefault` |
| `Schema.annotations({...})` | `.annotate({...})` (method) / `Schema.annotate({...})` (pipeable) |
| `Schema.TaggedRequest` | **DOES NOT EXIST in v4.** (`grep TaggedRequest` over `src/` and `dist/dts/` → zero hits.) Use `Rpc.make` from `effect/unstable/rpc` for request/response pairs, or a `TaggedClass` payload + explicit success/error schemas. |
| `Schema.Literal("a","b")` variadic | `Schema.Literal(x)` is **single**; use `Schema.Literals(["a","b"])` for the union. |
| `.pick(...)` / `.omit(...)` on Struct | no such methods — `S.mapFields(Struct.pick(["a","b"]))` using `Struct` from `"effect"`. |
| `Schema.JSONSchema.make` | `Schema.toJsonSchemaDocument(schema, opts)` → `JsonSchema.Document<"draft-2020-12">` |

---

## 2. Primitives & combinators (compiled — `.recon/schema.ts`)

```ts
import { Schema } from "effect"

const Primitives = Schema.Struct({
  s: Schema.String,
  n: Schema.Number,
  i: Schema.Int,                      // Number.check(isInt())
  fin: Schema.Finite,
  b: Schema.Boolean,
  nes: Schema.NonEmptyString,
  lit: Schema.Literal("a"),           // SINGLE literal only
  lits: Schema.Literals(["a", "b", "c"]),
  uni: Schema.Union([Schema.String, Schema.Number]),   // ARRAY argument, not variadic
  arr: Schema.Array(Schema.String),
  nea: Schema.NonEmptyArray(Schema.String),
  tup: Schema.Tuple([Schema.String, Schema.Number]),   // ARRAY argument
  rec: Schema.Record(Schema.String, Schema.Number),
  opt: Schema.Option(Schema.String),                   // Encoded: { _tag: "Some"|"None", value? }
  optNull: Schema.OptionFromNullOr(Schema.String),     // Encoded: string | null  <- use this at JSON edges
  nullOr: Schema.NullOr(Schema.String),
  undefOr: Schema.UndefinedOr(Schema.String),
  nullishOr: Schema.NullishOr(Schema.String),
  exactOptional: Schema.optionalKey(Schema.String),    // `a?: string`  (absent only)
  looseOptional: Schema.optional(Schema.String),       // `a?: string | undefined` (absent OR undefined)
  defect: Schema.Defect(),                             // unknown <-> Json, Errors round-trip
  unknown: Schema.Unknown,
  date: Schema.Date,
  dateStr: Schema.DateFromString,
  numStr: Schema.NumberFromString,
  enumLike: Schema.Enum({ A: "a", B: "b" } as const)
})
type T = typeof Primitives["Type"]
type E = typeof Primitives["Encoded"]
```

Other notable built-ins: `Schema.Never | Any | Unknown | Null | Undefined | Void | Symbol | BigInt |
ObjectKeyword | UniqueSymbol | TemplateLiteral | TemplateLiteralParser | Char | Trim | Trimmed |
URLFromString | UUID-ish checks | Uint8ArrayFromBase64 | BigDecimal | Duration | DateTimeUtc |
ReadonlyMap | ReadonlySet | HashMap | HashSet | Chunk | Redacted | Result | Exit | Cause |
Headers | UrlParams | fromJsonString | fromFormData | fromURLSearchParams | Json | JsonObject`.

### `optionalKey` vs `optional` — the exact rule

- `Schema.optionalKey(S)` → `{ readonly k?: S["Type"] }` — key may be **absent**, `undefined` is a
  validation error.
- `Schema.optional(S)` → `{ readonly k?: S["Type"] | undefined }` — literally
  `optionalKey(UndefinedOr(S))`.
- Inverses: `Schema.requiredKey` / `Schema.required`.
- Also `Schema.mutableKey` / `readonlyKey`, `Schema.mutable`.

### Defaults (compiled + executed)

```ts
import { Effect, Schema } from "effect"

const WithDefaults = Schema.Struct({
  // decoding default: key ABSENT -> default. Type side stays REQUIRED.
  retries: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
  // decoding default: key absent OR undefined -> default
  label: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("anon"))),
  // constructor-only default: applied by .make(), NOT by decoding
  ctorOnly: Schema.String.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed("x"))
  )
})
Schema.decodeUnknownSync(WithDefaults)({})           // => { retries: 3, label: "anon" }
WithDefaults.make({ retries: 1, label: "l" })        // ctorOnly filled in
```

**GOTCHA (hit during recon):** do **not** write
`Schema.Number.pipe(Schema.optionalKey, Schema.withDecodingDefaultKey(...))`. The defaults
combinators already wrap the encoded side in `optionalKey`/`optional`; pre-wrapping makes the
**decoded** type optional too (`retries?: number | undefined`), which defeats the default.
Pre-wrap with `optionalKey` only for `withConstructorDefault`.

Default value is an `Effect`: `withDecodingDefault*` takes `Effect<…, SchemaError, R>`;
`withConstructorDefault` takes `Effect<…, SchemaIssue.Issue>`.
Both accept `{ encodingStrategy: "passthrough" | "omit" }` (default `"passthrough"`).

### Reuse / reshape a Struct

```ts
import { Schema, Struct } from "effect"
const Reused  = Schema.Struct({ ...Primitives.fields, extra: Schema.String })
const Picked  = Primitives.mapFields(Struct.pick(["s", "n"]))   // NOTE: array arg
const Omitted = Primitives.mapFields(Struct.omit(["s"]))
const Added   = Primitives.pipe(Schema.fieldsAssign({ c: Schema.Number }))
```

---

## 3. Classes, tagged classes, tagged errors

```ts
import { Effect, Schema } from "effect"

// Schema.Class<Self>(identifier)(fields)
class User extends Schema.Class<User>("app/User")({
  id: Schema.Int,
  name: Schema.NonEmptyString
}) {
  get label() { return `${this.id}:${this.name}` }       // methods/getters are yours
}
Schema.decodeUnknownSync(User)({ id: 1, name: "a" }) instanceof User   // => true (verified)
String(new User({ id: 1, name: "a" }))                 // => 'app/User({"id":1,"name":"a"})'
Object.keys(User.fields)                               // => ["id","name"]
class Admin extends User.extend<Admin>("app/Admin")({ level: Schema.Int }) {}

// Schema.TaggedClass<Self>(identifier?)(tag, fields) -- note the EMPTY first call
class Click extends Schema.TaggedClass<Click>()("Click", { selector: Schema.String }) {}
new Click({ selector: "#a" })._tag                     // => "Click"

// Schema.TaggedError<Self>(identifier?)(tag, fields) -- yieldable, extends Error
class DecodeFailed extends Schema.TaggedError<DecodeFailed>()("DecodeFailed", {
  path: Schema.String,
  detail: Schema.String
}) {}
const eff: Effect.Effect<never, DecodeFailed> = Effect.gen(function*() {
  return yield* new DecodeFailed({ path: "a.b", detail: "boom" })   // `new X(...)` is yieldable
})
```

There is also `Schema.Error` (untagged schema-backed error class) and `Schema.ErrorInstance`
(schema for a plain JS `Error`).

**GOTCHA (verified at runtime):** `new User({ id: 1.5, name: "" })` throws a plain `Error` whose
`.message` is the generic `"Schema validation failed"`; the real detail is in `err.cause`, which is a
`SchemaIssue.Issue` (`_tag: "Composite"`). Format it yourself:
`SchemaIssue.makeFormatterDefault()(err.cause as SchemaIssue.Issue)`.
Pass `{ disableChecks: true }` as the 2nd ctor arg to skip validation.

You can override `get message()` on a `TaggedError` subclass to produce a human string (compiled —
see §8).

---

## 4. Discriminated (tagged) unions + matching

```ts
import { Schema } from "effect"

const Step = Schema.TaggedUnion({
  Navigate: { url: Schema.String },
  Click:    { selector: Schema.String },
  Expect:   { selector: Schema.String, text: Schema.String }
})
type Step = typeof Step["Type"]    // { _tag: "Navigate", url } | { _tag: "Click", ... } | ...

// data-first
const describe = (s: Step) => Step.match(s, {
  Navigate: (x) => `goto ${x.url}`,
  Click:    (x) => `click ${x.selector}`,
  Expect:   (x) => `expect ${x.selector} ~ ${x.text}`
})
// data-last also supported: Step.match({ ... })(s)
Step.matchOrElse(s, { Navigate: (x) => x.url }, () => "other")   // partial + fallback
Step.guards.Navigate(u)          // (u: unknown) => u is { _tag: "Navigate"; url: string }
Step.isAnyOf(["Navigate","Click"])
Step.cases.Navigate              // the member schema
```

Building the union yourself (members can be `TaggedStruct`s or `TaggedClass`es):

```ts
const Shape = Schema.Union([
  Schema.TaggedStruct("Circle", { r: Schema.Number }),
  Schema.TaggedStruct("Square", { side: Schema.Number })
]).pipe(Schema.toTaggedUnion("_tag"))       // adds .match/.guards/.cases/.isAnyOf
```

`toTaggedUnion` additionally exposes `.discriminants` (typed `readonly ["Circle","Square"]`), which
`Schema.TaggedUnion({...})` does **not** — neither at the type level nor at runtime (verified: its
impl only attaches `cases`, `isAnyOf`, `guards`, `match`, `matchOrElse`). `toTaggedUnion`'s
`matchOrElse` also has stricter exhaustiveness typing than `TaggedUnion`'s.

`toTaggedUnion` **throws at construction time** on duplicate discriminants or on a member with no
literal sentinel at the tag key. `Schema.tag(lit)` / `Schema.TaggedStruct(tag, fields)` are the
building blocks (`tag` = `Literal` + `withConstructorDefault`, so `.make` can omit `_tag`).

---

## 5. decode / encode / validate — the full family

Suffix decides the carrier. There is **no** un-suffixed `decodeUnknown`.

| | unknown input | typed-Encoded input |
|---|---|---|
| Effect | `decodeUnknownEffect` | `decodeEffect` |
| sync (throws) | `decodeUnknownSync` | `decodeSync` |
| `Result` | `decodeUnknownResult` | `decodeResult` |
| `Option` | `decodeUnknownOption` | `decodeOption` |
| `Exit` | `decodeUnknownExit` | `decodeExit` |
| `Promise` | `decodeUnknownPromise` | `decodePromise` |

Same six for encoding: `encodeUnknownEffect/Sync/Result/Option/Exit/Promise` and
`encodeEffect/encodeSync/encodeResult/encodeOption/encodeExit/encodePromise`.

Validation-only helpers (no `Schema.validate`):

```ts
Schema.is(schema)          // (u: unknown) => u is T   (type-side guard)
Schema.asserts(schema, u)  // asserts u is T           (2-arg, NOT curried)
Schema.toStandardSchemaV1(schema)   // Standard Schema v1 adapter
```

Every one takes `(schema, options?: SchemaAST.ParseOptions)`.

### `ParseOptions` — including the v3 `onExcessProperty` equivalent

```ts
interface SchemaAST.ParseOptions {
  readonly errors?: "first" | "all"            // default "first"
  readonly onExcessProperty?: "ignore" | "error"  // default "ignore" -> STRIPS unknown keys
  readonly disableChecks?: boolean
  readonly concurrency?: Types.Concurrency
  readonly reportInput?: boolean               // default false; includes rejected input in messages
}
```

Verified: with the default `"ignore"`, `decodeUnknownSync(Suite)({ …, junk: 9 })` returns the object
**without** `junk`. There is **no** `"preserve"` mode — to keep extra keys, model them
(`Schema.StructWithRest`, below).

`reportInput: true` upgrades `Expected "chromium" | "firefox" | "webkit"` to
`Expected "chromium" | "firefox" | "webkit", got "safari"` and excess-key messages from
`Expected no excess property` to `Unexpected key with value {"max":99}`. It can leak secrets — opt in
deliberately.

---

## 6. Errors: `SchemaError`, `SchemaIssue.Issue`, and human formatting

```ts
export class SchemaError extends Data.TaggedError("SchemaError")<{ readonly issue: SchemaIssue.Issue }> {
  override get message(): string   // == SchemaIssue.defaultFormatter(this.issue)
  override toString(): string      // "SchemaError(<message>)"
}
Schema.isSchemaError(u): u is SchemaError
```

- Effect variants fail with `SchemaError` in the error channel → `Effect.catchTag("SchemaError", …)`.
- Sync variants **throw** `SchemaError` (verified `Schema.isSchemaError(thrown) === true`).
- `Result` variants give `Result.Result<T, SchemaError>` — `Result.isFailure(r)` then `r.failure`.
- **Exception:** `schema.makeEffect(...)` fails with a raw `SchemaIssue.Issue`, *not* a `SchemaError`.

Two formatters (module `SchemaIssue`):

```ts
import { SchemaIssue } from "effect"

const text = SchemaIssue.makeFormatterDefault()            // Formatter<string>
const std  = SchemaIssue.makeFormatterStandardSchemaV1()   // Formatter<StandardSchemaV1.FailureResult>

text(error.issue)            // multi-line "<message>\n  at [\"a\"][\"b\"]"
std(error.issue).issues      // [{ message: string, path: ReadonlyArray<PropertyKey | {key}> }]
```

Both accept `{ leafHook?: (issue: Leaf) => string, checkHook?: (issue: Filter) => string | undefined }`.
`SchemaIssue.defaultFormatter` is the pre-built string formatter used by `SchemaError.message`.

**`Formatter` from `"effect"` is a DIFFERENT module** — `Formatter.format(value)` /
`Formatter.formatJson(value)` pretty-print arbitrary JS values. It has nothing to do with schema
issues. Use `SchemaIssue.*` for issue text.

Issue tree (`SchemaIssue.Issue`, all `_tag`ged, useful for custom rendering):
`InvalidType | InvalidValue | MissingKey | UnexpectedKey | Forbidden` (leaves) and
`Filter | Encoding | Pointer | Composite | AnyOf | OneOf` (nodes). `Pointer.path` accumulates the
property path; `Composite.issues` / `AnyOf.issues` fan out.

Real output (executed) with `{ errors: "all", onExcessProperty: "error" }`:

```
Expected no excess property
  at ["extra"]
Expected a value with a length of at least 1
  at ["name"]
Expected "chromium" | "firefox" | "webkit"
  at ["browser"]
Expected no excess property
  at ["retry"]["oops"]
Expected a value greater than or equal to 0
  at ["retry"]["max"]
```

---

## 7. Filters / refinements / brands

`.check(...checks)` (method) or `Schema.check(...checks)` (pipeable). Checks are
`SchemaAST.Check<T>` values, **not** predicates.

```ts
const Port = Schema.Int.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(65535, { message: "port must be <= 65535" })
  ),
  Schema.brand("Port")
)
type Port = typeof Port["Type"]   // number & Brand<"Port">

const Slug = Schema.String.pipe(Schema.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40),
  Schema.isPattern(/^[a-z0-9-]+$/, { message: "must be kebab-case" })
))

// refine = type-guard narrowing + runtime check
const Even = Schema.Number.pipe(
  Schema.refine((n): n is number => n % 2 === 0, { message: "must be even" })
)
```

Built-in check constructors (all take an optional trailing `Annotations.Filter`):
**numbers** `isGreaterThan · isGreaterThanOrEqualTo · isLessThan · isLessThanOrEqualTo ·
isBetween({minimum,maximum}) · isMultipleOf · isInt · isInt32 · isUint32 · isFinite`;
**strings** `isMinLength · isMaxLength · isLengthBetween · isNonEmpty · isPattern(RegExp) ·
isTrimmed · isStartsWith · isEndsWith · isIncludes · isUppercased · isLowercased · isCapitalized ·
isUncapitalized · isUUID(version?) · isULID · isGUID · isBase64 · isBase64Url`;
**arrays/collections** `isMinLength · isMaxLength · isUnique · isMinSize · isMaxSize · isSizeBetween`;
**objects** `isMinProperties · isMaxProperties · isPropertiesLengthBetween · isPropertyNames`;
plus `…Date` / `…BigInt` / `…BigDecimal` variants of the ordering checks.

Custom checks — `Schema.makeFilter` (compiled + executed):

```ts
const Range = Schema.Struct({ lo: Schema.Number, hi: Schema.Number }).check(
  Schema.makeFilter(
    (r) => (r.lo <= r.hi ? undefined : [{ path: ["hi"], issue: "hi must be >= lo" }]),
    { expected: "a valid range" }
  )
)
const UpperTag = Schema.String.check(
  Schema.makeFilter((s) => s === s.toUpperCase() || "must be UPPERCASE")
)
```
→ prints `hi must be >= lo\n  at ["hi"]` and `must be UPPERCASE`.

`FilterOutput = undefined | boolean | FilterIssue | ReadonlyArray<FilterIssue>`, where
`FilterIssue = string | SchemaIssue.Issue | { path: ReadonlyArray<PropertyKey>, issue: string | Issue }`.
`undefined`/`true` = pass. `Schema.makeFilterGroup(checks, annotations?)` groups checks under one
shared annotation. `Schema.fromBrand(id, brandCtor)` applies an existing `Brand.Constructor`.

**Message precedence for a failed check:** filter annotation `message` → filter annotation
`expected` (rendered `Expected <expected>`) → `<filter>`. A node's `identifier` names *type-level*
failures **before** the filter runs; it never names the failed filter.

---

## 8. Annotations (exact v4 API)

`.annotate(annotations)` on any schema; `.annotateKey(annotations)` for struct-field-position
annotations; pipeables `Schema.annotate`, `Schema.annotateKey`, `Schema.annotateEncoded`.
Read back with `Schema.resolveAnnotations(schema)` / `Schema.resolveAnnotationsKey(schema)`.

```ts
const AnnotatedId = Schema.String.annotate({
  identifier: "TestId",          // stable name; becomes a $defs key in JSON Schema
  title: "Test id",
  description: "Stable identifier for a test case",
  examples: ["login-happy-path"],   // ReadonlyArray<T>
  default: "case-1",                // T
  documentation: "…",
  format: "uuid", readOnly: true, writeOnly: false,
  contentEncoding: "base64", contentMediaType: "application/json", contentSchema: {},
  message: "…",                     // full replacement message for this node's issues
  messageUnexpectedKey: "…",
  expected: "…",                    // "Expected <expected>"
  brands: ["Port"]
})
Schema.String.annotateKey({ messageMissingKey: "the name field is required" })
```

Annotation interfaces: `Annotations.Annotations` (open index signature — module-augmentable),
`Annotations.Augment`, `Annotations.Documentation<T>`, `Annotations.Key<T>`,
`Annotations.Bottom<T, TypeParameters>`, `Annotations.Filter`, `Annotations.Declaration<T, …>`.
Setting a key to `undefined` removes it. You can module-augment
`declare module "effect/Schema" { namespace Annotations { interface Annotations { readonly version?: … } } }`.

---

## 9. JSON Schema generation (REQUIRED for LLM tool defs)

```ts
Schema.toJsonSchemaDocument(
  schema: Schema.Constraint,
  options?: Schema.ToJsonSchemaOptions
): JsonSchema.Document<"draft-2020-12">

interface JsonSchema.Document<D> {
  readonly dialect: D                 // "draft-2020-12"
  readonly schema: JsonSchema.JsonSchema   // the ROOT schema  <- feed this to the tool def
  readonly definitions: JsonSchema.Definitions   // the $defs pool
}

interface ToJsonSchemaOptions {
  readonly onExcessProperty?: "ignore" | "error"   // default "ignore" -> additionalProperties: true
  readonly generateDescriptions?: boolean
  readonly includeAnnotationKey?: (key: string) => boolean
  readonly referencePolicy?: (input: { ast; occurrences: number; identifier: string | undefined }) => string | undefined
}
```

**Two must-know behaviours (both verified by running):**

1. Any schema carrying an `identifier` annotation is hoisted into `definitions` and the root becomes
   `{ "$ref": "#/$defs/Name" }`. For LLM tool parameters you usually want a **single self-contained
   object**, so pass `referencePolicy: () => undefined` to force everything inline (recursive schemas
   still get a synthetic ref — they have to).
2. `onExcessProperty` defaults to `"ignore"` → emits `"additionalProperties": true`. Pass
   `"error"` to emit `"additionalProperties": false`, and pass `onExcessProperty: "error"` to the
   **decoder** too; the two options are independent.

Verified output for `Schema.toJsonSchemaDocument(HarnessConfig, { onExcessProperty: "error", referencePolicy: () => undefined }).schema`:

```json
{"type":"object","properties":{
  "name":{"type":"string","minLength":1,"description":"Suite name"},
  "browser":{"type":"string","enum":["chromium","firefox","webkit"]},
  "baseUrl":{"type":"string"},
  "retry":{"type":"object","properties":{"max":{"type":"integer","minimum":0,"maximum":10},
           "backoffMs":{"type":"integer"}},"required":["max"],"additionalProperties":false},
  "headless":{"type":"boolean"},
  "env":{"type":"object","additionalProperties":{"type":"string"}},
  "steps":{"type":"array","items":{"anyOf":[ /* one closed object per tag */ ]}}
}}
```

Notes: a `TaggedUnion` emits `anyOf` of closed objects, each with
`"_tag":{"type":"string","enum":["Navigate"]}`. A field with `withDecodingDefaultKey` is correctly
omitted from `required`. Checks are lowered (`minLength`, `minimum`, `maximum`, `pattern`) —
`pattern` loses RegExp flags, string lengths are code-points in JSON Schema vs UTF-16 in Effect, so
**the Effect decoder stays the authority**; JSON Schema is "best effort / preliminary validation".

Other converters: `Schema.toJsonSchemaDocument` is the one you want.
`JsonSchema.toDocumentDraft07 / toDocumentDraft04 / toMultiDocumentOpenApi3_1` downgrade an existing
document; `SchemaRepresentation.toJsonSchemaMultiDocument` shares one `$defs` pool across roots.
Also `Schema.toStandardJSONSchemaV1(schema)`.

---

## 10. Rejecting unknown keys — the three levers

1. **Per-decode:** `Schema.decodeUnknownEffect(S, { onExcessProperty: "error" })`. Default `"ignore"`
   silently strips. There is no schema-level "strict struct" flag — this is a **parse option**, so
   wrap it once in a helper and reuse it.
2. **JSON Schema:** `toJsonSchemaDocument(S, { onExcessProperty: "error" })` → `additionalProperties: false`.
3. **Deliberately open:** `Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [Schema.Record(Schema.String, Schema.Unknown)])`.
   **GOTCHA (verified):** once an index signature covers the key space, `onExcessProperty: "error"`
   is a no-op for that struct — a key covered by any index signature is not "excess".

---

## 11. Worked example — nested YAML-derived config, strict keys, human errors

Compiled at `.recon/schema-config.ts`, executed via `.recon/run-config.ts`.

```ts
import { Effect, Result, Schema, SchemaIssue } from "effect"

const Retry = Schema.Struct({
  max: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  backoffMs: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(250)))
}).annotate({ identifier: "Retry" })

const Step = Schema.TaggedUnion({
  Navigate: { url: Schema.String.check(Schema.isPattern(/^https?:\/\//, { message: "must be an http(s) URL" })) },
  Click:    { selector: Schema.String.check(Schema.isNonEmpty()) },
  Expect:   { selector: Schema.String, text: Schema.String }
})

export const HarnessConfig = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()).annotate({ description: "Suite name" }),
  browser: Schema.Literals(["chromium", "firefox", "webkit"]),
  baseUrl: Schema.String,
  retry: Retry,
  headless: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  steps: Schema.Array(Step).check(Schema.isMinLength(1, { expected: "at least one step" }))
}).annotate({ identifier: "HarnessConfig" })

export type HarnessConfig = typeof HarnessConfig["Type"]

const STRICT = { errors: "all", onExcessProperty: "error", reportInput: true } as const
const decodeStrict = Schema.decodeUnknownResult(HarnessConfig, STRICT)
const decodeStrictEffect = Schema.decodeUnknownEffect(HarnessConfig, STRICT)

const stdFormatter = SchemaIssue.makeFormatterStandardSchemaV1()

export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()("ConfigInvalid", {
  source: Schema.String,
  problems: Schema.Array(Schema.String)
}) {
  override get message(): string {
    return `${this.source}: invalid config\n${this.problems.map((p) => `  - ${p}`).join("\n")}`
  }
}

// path segments are PropertyKey | { key: PropertyKey } -> normalise before joining
export const explain = (error: Schema.SchemaError): ReadonlyArray<string> =>
  stdFormatter(error.issue).issues.map((i) => {
    const path = (i.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".")
    return path === "" ? i.message : `${path}: ${i.message}`
  })

export const loadConfig = (source: string, raw: unknown): Effect.Effect<HarnessConfig, ConfigInvalid> =>
  decodeStrictEffect(raw).pipe(
    Effect.mapError((e) => new ConfigInvalid({ source, problems: explain(e) }))
  )

export const loadConfigSync = (source: string, raw: unknown): HarnessConfig => {
  const r = decodeStrict(raw)
  if (Result.isFailure(r)) throw new ConfigInvalid({ source, problems: explain(r.failure) })
  return r.success
}
```

Real executed output for a valid input (defaults applied):

```
{"name":"smoke","browser":"chromium","baseUrl":"https://x.dev.dcmps.fr",
 "retry":{"max":2,"backoffMs":250},"headless":true,
 "steps":[{"_tag":"Navigate","url":"https://x"},{"_tag":"Click","selector":"#go"}]}
```

Real executed output of `ConfigInvalid.message` for a broken input:

```
cfg.yaml: invalid config
  - retries: Unexpected key with value {"max":99}
  - name: Expected a value with a length of at least 1, got ""
  - browser: Expected "chromium" | "firefox" | "webkit", got "safari"
  - retry.nope: Unexpected key with value 1
  - retry.max: Expected a value between 0 and 10, got 99
  - steps.0.url: must be an http(s) URL
  - steps.1: Expected { readonly "_tag": "Navigate", ... } | { readonly "_tag": "Click", ... } | { readonly "_tag": "Expect", ... }, got {"_tag":"Nope"}
```

**Note the typo key `retries` was reported** — that is exactly why `onExcessProperty: "error"` matters
for config files. Array indices appear as path segments (`steps.0.url`), so `.` joining gives
usable YAML-ish paths. For a YAML source, parse first (any YAML lib → plain JS object), then hand the
plain object to `decodeStrict`; Schema never sees YAML text.
UNVERIFIED: `yaml@2.9.0` is present in the pnpm store as a transitive dep and resolves from the root
today, but it is **not** a declared dependency — add it explicitly before importing it.

---

## 12. Recursion, transformation, misc

```ts
// Recursive: annotate the value with an explicit interface + Schema.suspend
export interface Node { readonly name: string; readonly children: ReadonlyArray<Node> }
export const Node: Schema.Codec<Node> = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Node> => Node))
}).annotate({ identifier: "Node" })
```

- Transformations: `Schema.decodeTo(to, transformation)`, `Schema.encodeTo`, `Schema.decode`,
  `Schema.encode`, with getters from `SchemaGetter` and ready-made ones in `SchemaTransformation`.
- `Schema.flip(schema)` swaps Type/Encoded. `Schema.toType` / `Schema.toEncoded` project one side.
- `Schema.catchDecoding` / `catchEncoding` (+ `…WithContext`) recover from decode/encode issues.
- `Schema.middlewareDecoding` / `middlewareEncoding` inject services into the parse.
- `Schema.toEquivalence(schema)`, `Schema.toFormatter(schema)`, `Schema.toIso(schema)`,
  `Schema.toDifferJsonPatch(schema)`, `Schema.toCodecJson(schema)`, `Schema.toCodecStringTree`.
- `Schema.declare` / `Schema.instanceOf` for opaque/third-party types.
- Key renaming at the wire boundary (pipeable, throws on duplicate encoded keys):
  `Schema.Struct({ a: Schema.String }).pipe(Schema.encodeKeys({ a: "wire_a" }))` →
  `Encoded` is `{ readonly wire_a: string }`.
- `class Person extends Schema.Opaque<Person>()(Schema.Struct({ name: Schema.String })) {}` —
  nominal wrapper; `Schema.decodeUnknownSync(Person)(...)` is typed `Person`.

---

## 13. What I verified, exactly

| file | tsc | executed |
|---|---|---|
| `.recon/smoke.ts` | ✅ | — |
| `.recon/schema.ts` (primitives, defaults, filters, brands, annotations, Class/TaggedClass/TaggedError, TaggedUnion+match, all decode/encode variants, formatters, JSON Schema) | ✅ | — |
| `.recon/schema-config.ts` (the §11 worked example) | ✅ | ✅ via `run-config.ts` |
| `.recon/schema-tu.ts` (discriminants, encodeKeys, Opaque) | ✅ | — |
| `.recon/schema-extra.ts` (makeFilter, StructWithRest, suspend/recursion, Option/Date round-trip, catchTag on SchemaError) | ✅ | ✅ via `run-extra.ts` |
| `.recon/run-schema.ts`, `.recon/run-config.ts`, `.recon/run-extra.ts`, `.recon/run-class.ts` | run scripts (import sibling `.ts` → need `allowImportingTsExtensions` for tsc; they were executed with `tsx`, not typechecked) | ✅ |

UNVERIFIED items are flagged inline; the only ones are the `yaml` dependency note (§11) and the
`Rpc.make` replacement for `TaggedRequest` (§1) — I confirmed `TaggedRequest` is **absent**, but did
not build an `Rpc.make` example (out of lane).

---

# APPENDIX (critic pass) — §9 re-verified by execution

`.recon/critic-schema.ts` compiles; `.recon/critic-schema-run.ts` was executed. Real output:

```
toJsonSchemaDocument(S, { onExcessProperty: "error", referencePolicy: () => undefined }).schema
 -> {"type":"object","properties":{...},"required":["observationId","ref"],
     "additionalProperties":false,"description":"Click an element by ref"}       definitions: {}

toJsonSchemaDocument(S, { onExcessProperty: "error" }).schema      // identifier annotation present
 -> {"$ref":"#/$defs/ClickParams"}   definitions: { ClickParams: {...} }

TaggedUnion -> {"anyOf":[{"type":"object","properties":{"_tag":{"type":"string","enum":["Navigate"]},
                "url":{"type":"string"}},"required":["_tag","url"],"additionalProperties":false}, …]}
```

Both §9 behaviours are exactly as documented: the `identifier` annotation forces a `$ref`, and
`referencePolicy: () => undefined` inlines it. **For LLM tool parameters always pass both
`onExcessProperty: "error"` and `referencePolicy: () => undefined`.**

Related, and easy to miss: `effect/unstable/ai` has its own wrapper, `Tool.getJsonSchema(tool)`,
which calls `toJsonSchemaDocument` with **default** options — so it emits `additionalProperties: true`
and may leave a `$ref`/`$defs` in place. See api-effect-ai.md §B1 before using it.
