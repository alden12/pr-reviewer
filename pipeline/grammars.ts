/**
 * Every language the reviewer parses (ARCH-9), each a table of its grammar's node types: which are imports, comments and
 * the declarations and literals worth folding, and how each is named. Adding a language is an entry here, not a
 * recogniser. The node types come from each grammar's `node-types.json`; printing a parsed file's tree
 * (`rootNode.toString()`) is the quickest way to find them.
 *
 * Grammars are prebuilt WASM: `@vscode/tree-sitter-wasm` (VS Code's, current) for most, the language's own package
 * where it ships one (Scala, and Kotlin from the tree-sitter grammars org), and, for Swift, whose package ships only
 * C source, a build made here from its pinned source and committed (`grammars/build.sh`). An older third-party bundle
 * of prebuilt grammars was used for Kotlin and Swift until its Swift build crashed Node 24: V8 runs out of memory
 * compiling it, a moment after loading.
 */
import type { Described, Node } from "./syntax.ts";

/** A language as tree-sitter sees it: its grammar file, and which of its node types are which construct. */
export interface Grammar {
  /** The grammar's WASM, as a module path. */
  wasm: string;
  /** The file extensions it reads, without the dot. */
  extensions: string[];
  /** Statements that bring names in. */
  imports: string[];
  /** Which of those really are imports, where a node type covers more (an `export` is one only with a `from`). */
  importWhen?: (node: Node) => boolean;
  /** Node types that are comments: hidden as prose in the app, and read through in a run of imports. */
  comments: string[];
  /**
   * What else a comment-only line may hold around its comment: JSX's `{/* ... *\/}` braces. A line with any other code
   * on it is code with a comment at its end, which stays code.
   */
  around?: RegExp;
  /** Node types that sit above an item and belong with it (Rust's `#[derive(...)]`), so a span starts at them. */
  leading?: string[];
  describe?: Record<string, (node: Node) => Described | null>;
}

const VSCODE = "@vscode/tree-sitter-wasm/wasm";
/** Grammars with no maintained WASM build, built here from their pinned source (`grammars/build.sh`). */
const BUILT = "./grammars";

const textOf = (node: Node | null | undefined): string[] => (node ? [node.text] : []);
const named = (node: Node, field: string) => textOf(node.childForFieldName(field));
/** Every child under a field that can repeat (Swift names several bindings in one declaration). */
const fieldNodes = (node: Node, field: string) =>
  node.childrenForFieldName(field).flatMap((child) => (child ? [child] : []));
const firstOfType = (node: Node, type: string) => node.namedChildren.find((child) => child?.type === type) ?? null;

/** The names inside a body node, by the child types that carry one and how each is named. */
const namesIn = (body: Node | null | undefined, naming: Record<string, (child: Node) => string[]>): string[] =>
  (body?.namedChildren ?? []).flatMap((child) => (child && naming[child.type] ? naming[child.type]!(child) : []));

const declaration = (name: string, keys: string[]): Described => ({ kind: "types", name, keys });
const literal = (keys: string[]): Described | null => (keys.length > 0 ? { kind: "object", name: "", keys } : null);

const RUST_FIELDS = { field_declaration: (child: Node) => named(child, "name") };

const RUST: Grammar["describe"] = {
  struct_item: (node) =>
    declaration(`struct ${named(node, "name")}`, namesIn(node.childForFieldName("body"), RUST_FIELDS)),
  union_item: (node) =>
    declaration(`union ${named(node, "name")}`, namesIn(node.childForFieldName("body"), RUST_FIELDS)),
  enum_item: (node) =>
    declaration(
      `enum ${named(node, "name")}`,
      namesIn(node.childForFieldName("body"), { enum_variant: (child) => named(child, "name") }),
    ),
  type_item: (node) => declaration(`type ${named(node, "name")}`, []),
  struct_expression: (node) =>
    literal(
      namesIn(node.childForFieldName("body"), {
        field_initializer: (child) => named(child, "field"),
        shorthand_field_initializer: (child) => textOf(child.namedChildren[0]),
        base_field_initializer: (child) => [`..${child.namedChildren[0]?.text ?? ""}`],
      }),
    ),
  // Destructuring, but never a parameter: `fn f(Foo { a, .. }: Foo)` is a signature, not data to skim.
  struct_pattern: (node) =>
    node.parent?.type === "parameter"
      ? null
      : literal(
          namesIn(node, {
            field_pattern: (child) => named(child, "name"),
            remaining_field_pattern: () => [".."],
          }),
        ),
};

/** Go's `type X struct`, `type X interface` and the rest, named by what follows the name. */
const goType = (node: Node): Described | null => {
  const spec = firstOfType(node, "type_spec");
  if (spec === null) return null;
  const name = named(spec, "name").join("");
  const body = spec.childForFieldName("type");
  const shapes: Record<string, () => Described> = {
    struct_type: () =>
      declaration(
        `struct ${name}`,
        namesIn(firstOfType(body!, "field_declaration_list"), {
          field_declaration: (field) => field.childrenForFieldName("name").flatMap(textOf),
        }),
      ),
    interface_type: () =>
      declaration(
        `interface ${name}`,
        namesIn(body, { method_elem: (method) => named(method, "name"), type_elem: (embedded) => textOf(embedded) }),
      ),
  };
  return shapes[body?.type ?? ""]?.() ?? declaration(`type ${name}`, []);
};

const GO: Grammar["describe"] = {
  type_declaration: goType,
  // Keyed literals only (`Clip{Start: 1}`): a list of bare values has no keys to summarise it by.
  composite_literal: (node) =>
    literal(
      namesIn(node.childForFieldName("body"), {
        keyed_element: (element) => textOf(element.namedChildren[0]),
      }),
    ),
};

const unquote = (text: string) => text.replace(/^["']|["']$/g, "");

const PYTHON_MEMBERS = {
  expression_statement: (statement: Node) =>
    statement.namedChildren.flatMap((child) => (child?.type === "assignment" ? named(child, "left") : [])),
  function_definition: (definition: Node) => named(definition, "name"),
  decorated_definition: (decorated: Node) => named(decorated.childForFieldName("definition")!, "name"),
  class_definition: (definition: Node) => named(definition, "name"),
};

const pythonClass = (node: Node) =>
  declaration(`class ${named(node, "name")}`, namesIn(node.childForFieldName("body"), PYTHON_MEMBERS));

const PYTHON: Grammar["describe"] = {
  // A decorated class folds from its first decorator.
  decorated_definition: (node) => {
    const definition = node.childForFieldName("definition");
    return definition?.type === "class_definition" ? pythonClass(definition) : null;
  },
  class_definition: (node) => (node.parent?.type === "decorated_definition" ? null : pythonClass(node)),
  dictionary: (node) =>
    literal(
      namesIn(node, {
        pair: (pair) => named(pair, "key").map(unquote),
        dictionary_splat: (splat) => [splat.text],
      }),
    ),
};

/** A Kotlin declaration's name: a field on most, the first identifier on a type alias. */
const kotlinName = (node: Node) => (named(node, "name")[0] ?? textOf(firstOfType(node, "identifier"))[0] ?? "").trim();
const KOTLIN_MEMBERS = {
  property_declaration: (property: Node) => textOf(firstOfType(property, "variable_declaration")),
  function_declaration: (method: Node) => named(method, "name"),
  class_declaration: (inner: Node) => [kotlinName(inner)],
  object_declaration: (inner: Node) => [kotlinName(inner)],
  enum_entry: (entry: Node) => textOf(firstOfType(entry, "identifier")),
};

const KOTLIN: Grammar["describe"] = {
  class_declaration: (node) => {
    const keyword = node.children.find((child) => child && ["class", "interface"].includes(child.type))?.type;
    const enumBody = firstOfType(node, "enum_class_body");
    const kind = enumBody ? "enum class" : (keyword ?? "class");
    const parameters = namesIn(firstOfType(firstOfType(node, "primary_constructor") ?? node, "class_parameters"), {
      class_parameter: (parameter) => textOf(firstOfType(parameter, "identifier")),
    });
    const members = namesIn(enumBody ?? firstOfType(node, "class_body"), KOTLIN_MEMBERS);
    return declaration(`${kind} ${kotlinName(node)}`, [...parameters, ...members]);
  },
  object_declaration: (node) =>
    declaration(`object ${kotlinName(node)}`, namesIn(firstOfType(node, "class_body"), KOTLIN_MEMBERS)),
  type_alias: (node) => declaration(`typealias ${kotlinName(node)}`, []),
};

const SWIFT_MEMBERS = {
  property_declaration: (property: Node) =>
    fieldNodes(property, "name").flatMap((pattern) => named(pattern, "bound_identifier")),
  function_declaration: (method: Node) => named(method, "name"),
  protocol_function_declaration: (method: Node) => named(method, "name"),
  protocol_property_declaration: (property: Node) =>
    fieldNodes(property, "name").flatMap((pattern) => named(pattern, "bound_identifier")),
  enum_entry: (entry: Node) => entry.childrenForFieldName("name").flatMap(textOf),
  class_declaration: (inner: Node) => named(inner, "name"),
};

const SWIFT: Grammar["describe"] = {
  // One node type for struct, class, enum, extension and actor: the keyword says which.
  class_declaration: (node) =>
    declaration(
      `${named(node, "declaration_kind").join("") || "class"} ${named(node, "name")}`,
      namesIn(node.childForFieldName("body"), SWIFT_MEMBERS),
    ),
  protocol_declaration: (node) =>
    declaration(`protocol ${named(node, "name")}`, namesIn(node.childForFieldName("body"), SWIFT_MEMBERS)),
  typealias_declaration: (node) => declaration(`typealias ${named(node, "name")}`, []),
  dictionary_literal: (node) => literal(fieldNodes(node, "key").map((key) => unquote(key.text))),
};

const SCALA_MEMBERS = {
  val_definition: (value: Node) => named(value, "pattern"),
  var_definition: (value: Node) => named(value, "pattern"),
  val_declaration: (value: Node) => named(value, "name"),
  var_declaration: (value: Node) => named(value, "name"),
  function_definition: (method: Node) => named(method, "name"),
  function_declaration: (method: Node) => named(method, "name"),
  class_definition: (inner: Node) => named(inner, "name"),
  object_definition: (inner: Node) => named(inner, "name"),
  enum_case_definitions: (cases: Node) =>
    cases.namedChildren.flatMap((enumCase) => (enumCase ? named(enumCase, "name") : [])),
};

/** A Scala definition's parameters (a case class's fields) and its body's members. */
const scalaKeys = (node: Node) => [
  ...namesIn(node.childForFieldName("class_parameters"), { class_parameter: (parameter) => named(parameter, "name") }),
  ...namesIn(node.childForFieldName("body"), SCALA_MEMBERS),
];

const SCALA: Grammar["describe"] = {
  class_definition: (node) => declaration(`class ${named(node, "name")}`, scalaKeys(node)),
  trait_definition: (node) => declaration(`trait ${named(node, "name")}`, scalaKeys(node)),
  object_definition: (node) => declaration(`object ${named(node, "name")}`, scalaKeys(node)),
  enum_definition: (node) => declaration(`enum ${named(node, "name")}`, scalaKeys(node)),
  type_definition: (node) => declaration(`type ${named(node, "name")}`, []),
};

/** An object's keys, a destructuring's names, a type's members: shared by TypeScript and JavaScript. */
const OBJECT_KEYS = {
  pair: (pair: Node) => named(pair, "key"),
  shorthand_property_identifier: (key: Node) => [key.text],
  spread_element: (spread: Node) => [`...${spread.namedChildren[0]?.text ?? ""}`],
  method_definition: (method: Node) => named(method, "name"),
};
const PATTERN_NAMES = {
  shorthand_property_identifier_pattern: (name: Node) => [name.text],
  // `{ a: b }` binds `b`, the name the code then uses.
  pair_pattern: (pair: Node) => named(pair, "value"),
  object_assignment_pattern: (assigned: Node) => named(assigned, "left"),
  rest_pattern: (rest: Node) => [`...${rest.namedChildren[0]?.text ?? ""}`],
};
const TYPE_MEMBERS = {
  property_signature: (member: Node) => named(member, "name"),
  method_signature: (member: Node) => named(member, "name"),
};
const PARAMETERS = ["required_parameter", "optional_parameter", "formal_parameters"];

const JAVASCRIPT: Grammar["describe"] = {
  object: (node) => literal(namesIn(node, OBJECT_KEYS)),
  // Destructuring, but never a parameter list: `({ a, b }) => ...` is a function's signature, not data to skim.
  object_pattern: (node) =>
    PARAMETERS.includes(node.parent?.type ?? "") ? null : literal(namesIn(node, PATTERN_NAMES)),
};

const TYPESCRIPT: Grammar["describe"] = {
  ...JAVASCRIPT,
  interface_declaration: (node) =>
    declaration(`interface ${named(node, "name")}`, namesIn(node.childForFieldName("body"), TYPE_MEMBERS)),
  // A type's members only when it is an object type: `type U = A | B` is named, with nothing to list.
  type_alias_declaration: (node) => {
    const value = node.childForFieldName("value");
    return declaration(
      `type ${named(node, "name")}`,
      value?.type === "object_type" ? namesIn(value, TYPE_MEMBERS) : [],
    );
  },
};

/** A script: imports are statements the parser says are, so `import.meta` and `import()` never are. */
const script = (wasm: string, extensions: string[], describe: Grammar["describe"], around?: RegExp): Grammar => ({
  wasm: `${VSCODE}/${wasm}`,
  extensions,
  imports: ["import_statement", "export_statement"],
  importWhen: (node) => node.type === "import_statement" || node.childForFieldName("source") !== null,
  comments: ["comment"],
  describe,
  ...(around ? { around } : {}),
});

export const GRAMMARS: Grammar[] = [
  {
    wasm: `${VSCODE}/tree-sitter-rust.wasm`,
    extensions: ["rs"],
    imports: ["use_declaration", "extern_crate_declaration"],
    comments: ["line_comment", "block_comment"],
    leading: ["attribute_item"],
    describe: RUST,
  },
  {
    wasm: `${VSCODE}/tree-sitter-go.wasm`,
    extensions: ["go"],
    imports: ["import_declaration"],
    comments: ["comment"],
    describe: GO,
  },
  {
    wasm: `${VSCODE}/tree-sitter-python.wasm`,
    extensions: ["py", "pyi"],
    imports: ["import_statement", "import_from_statement", "future_import_statement"],
    comments: ["comment"],
    describe: PYTHON,
  },
  {
    wasm: "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm",
    extensions: ["kt", "kts"],
    imports: ["import"],
    comments: ["line_comment", "block_comment"],
    describe: KOTLIN,
  },
  {
    wasm: `${BUILT}/tree-sitter-swift.wasm`,
    extensions: ["swift"],
    imports: ["import_declaration"],
    comments: ["comment", "multiline_comment"],
    describe: SWIFT,
  },
  {
    wasm: "tree-sitter-scala/tree-sitter-scala.wasm",
    extensions: ["scala", "sc"],
    imports: ["import_declaration"],
    comments: ["comment", "block_comment"],
    describe: SCALA,
  },
  script("tree-sitter-typescript.wasm", ["ts", "mts", "cts"], TYPESCRIPT),
  // JSX's `{/* ... */}`: the braces around a comment leave its line a comment line.
  script("tree-sitter-tsx.wasm", ["tsx"], TYPESCRIPT, /^[\s{}]*$/),
  script("tree-sitter-javascript.wasm", ["js", "jsx", "mjs", "cjs"], JAVASCRIPT, /^[\s{}]*$/),
  { wasm: `${VSCODE}/tree-sitter-css.wasm`, extensions: ["css"], imports: [], comments: ["comment"] },
];
