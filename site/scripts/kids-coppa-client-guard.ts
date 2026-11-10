import * as ts from "typescript";

export type StorageAccess = {
  operation: "get" | "set" | "remove" | "property-write" | "unknown";
  keys: string[] | null;
  values: string[] | null;
  expression: string;
};

export type NetworkWrite = {
  api: "fetch" | "XMLHttpRequest";
  methods: string[] | null;
  targets: string[] | null;
  expression: string;
};

export type ClientCodeAnalysis = {
  forbiddenApis: string[];
  storageAccesses: StorageAccess[];
  networkWrites: NetworkWrite[];
};

export type ModuleDependencyAnalysis = {
  specifiers: string[];
  unresolved: string[];
};

export type StoragePolicy = ReadonlyMap<string, ReadonlySet<string>>;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const STORAGE_METHODS = new Set(["getItem", "setItem", "removeItem"]);
const STORAGE_NON_KEY_MEMBERS = new Set(["length", "clear", "key"]);
const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function combineValues(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): Set<string> | null {
  if (left.size * right.size > 64) return null;
  const values = new Set<string>();
  for (const a of left) {
    for (const b of right) values.add(a + b);
  }
  return values;
}

type ScopedBinding = {
  scope: ts.Node;
  declaration: ts.Node;
  initializer: ts.Expression | null;
};

const scopedBindingsBySource = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, readonly ScopedBinding[]>
>();

type ScopedInitializerResolution =
  | { found: false }
  | { found: true; initializer: ts.Expression | null };

function scopedInitializerFor(
  identifier: ts.Identifier,
): ScopedInitializerResolution {
  const bindings = scopedBindingsBySource
    .get(identifier.getSourceFile())
    ?.get(identifier.text);
  if (!bindings || bindings.length === 0) return { found: false };

  const containing = bindings.filter(
    (binding) =>
      binding.scope.pos <= identifier.pos && identifier.end <= binding.scope.end,
  );
  if (containing.length === 0) return { found: false };

  const closestSpan = Math.min(
    ...containing.map((binding) => binding.scope.end - binding.scope.pos),
  );
  const closest = containing.filter(
    (binding) => binding.scope.end - binding.scope.pos === closestSpan,
  );
  const closestScope = closest[0]?.scope;
  const declarations = containing.filter(
    (binding) => binding.scope === closestScope,
  );
  if (declarations.length !== 1) {
    return { found: true, initializer: null };
  }

  const binding = declarations[0];
  if (!binding.initializer || binding.initializer.end > identifier.pos) {
    return { found: true, initializer: null };
  }
  return { found: true, initializer: binding.initializer };
}

function stringValues(
  expression: ts.Expression | undefined,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
  depth = 0,
): Set<string> | null {
  if (!expression || depth > 20) return null;
  const node = unwrapExpression(expression);
  if (ts.isStringLiteralLike(node)) return new Set([node.text]);
  if (ts.isIdentifier(node)) {
    const scoped = scopedInitializerFor(node);
    if (scoped.found) {
      return scoped.initializer
        ? stringValues(scoped.initializer, constants, depth + 1)
        : null;
    }
    const values = constants.get(node.text);
    return values ? new Set(values) : null;
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = stringValues(node.whenTrue, constants, depth + 1);
    const whenFalse = stringValues(node.whenFalse, constants, depth + 1);
    if (!whenTrue || !whenFalse) return null;
    return new Set([...whenTrue, ...whenFalse]);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = stringValues(node.left, constants, depth + 1);
    const right = stringValues(node.right, constants, depth + 1);
    return left && right ? combineValues(left, right) : null;
  }
  if (ts.isTemplateExpression(node)) {
    let values = new Set([node.head.text]);
    for (const span of node.templateSpans) {
      const expressionValues = stringValues(
        span.expression,
        constants,
        depth + 1,
      );
      if (!expressionValues) return null;
      const combined = combineValues(values, expressionValues);
      if (!combined) return null;
      values = new Set(
        [...combined].map((value) => value + span.literal.text),
      );
    }
    return values;
  }
  return null;
}

type Initializers = {
  strings: Map<string, ts.Expression>;
  objects: Map<string, ts.ObjectLiteralExpression>;
};

function nearestScope(
  node: ts.Node,
  predicate: (candidate: ts.Node) => boolean,
): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current && !predicate(current)) current = current.parent;
  return current ?? node.getSourceFile();
}

function lexicalScopeForVariable(node: ts.VariableDeclaration): ts.Node {
  const declarationList = node.parent;
  const blockScoped =
    ts.isVariableDeclarationList(declarationList) &&
    (declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0;

  if (!blockScoped) {
    return nearestScope(
      node,
      (candidate) => ts.isFunctionLike(candidate) || ts.isSourceFile(candidate),
    );
  }

  const owner = declarationList.parent;
  if (
    ts.isForStatement(owner) ||
    ts.isForInStatement(owner) ||
    ts.isForOfStatement(owner)
  ) {
    return owner;
  }
  return nearestScope(
    node,
    (candidate) =>
      ts.isBlock(candidate) ||
      ts.isCaseBlock(candidate) ||
      ts.isSourceFile(candidate),
  );
}

function enclosingLexicalScope(node: ts.Node): ts.Node {
  return nearestScope(
    node,
    (candidate) =>
      ts.isBlock(candidate) ||
      ts.isCaseBlock(candidate) ||
      ts.isSourceFile(candidate),
  );
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function assignedRootNames(expression: ts.Expression): string[] {
  const node = unwrapExpression(expression);
  if (ts.isIdentifier(node)) return [node.text];
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    return assignedRootNames(node.expression);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) =>
      ts.isOmittedExpression(element) || ts.isSpreadElement(element)
        ? []
        : assignedRootNames(element),
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) => {
      if (ts.isSpreadAssignment(property)) {
        return assignedRootNames(property.expression);
      }
      if (ts.isPropertyAssignment(property)) {
        return assignedRootNames(property.initializer);
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return [property.name.text];
      }
      return [];
    });
  }
  return [];
}

function collectInitializers(sourceFile: ts.SourceFile): Initializers {
  const bindingCounts = new Map<string, number>();
  const variableDeclarations: Array<{
    name: string;
    initializer: ts.Expression;
    isConst: boolean;
    declaration: ts.VariableDeclaration;
  }> = [];
  const scopedBindings = new Map<string, ScopedBinding[]>();
  const mutated = new Set<string>();

  const count = (name: string): void => {
    bindingCounts.set(name, (bindingCounts.get(name) ?? 0) + 1);
  };
  const recordBinding = (name: string, binding: ScopedBinding): void => {
    const entries = scopedBindings.get(name) ?? [];
    entries.push(binding);
    scopedBindings.set(name, entries);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const names = bindingNames(node.name);
      for (const name of names) count(name);
      const declarationList = node.parent;
      const isConst =
        ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.Const) !== 0;
      const scope = lexicalScopeForVariable(node);
      for (const name of names) {
        recordBinding(name, {
          scope,
          declaration: node,
          initializer:
            isConst && ts.isIdentifier(node.name) && node.name.text === name
              ? (node.initializer ?? null)
              : null,
        });
      }
      if (ts.isIdentifier(node.name) && node.initializer) {
        variableDeclarations.push({
          name: node.name.text,
          initializer: node.initializer,
          isConst,
          declaration: node,
        });
      }
    } else if (ts.isParameter(node)) {
      const scope = nearestScope(node, (candidate) => ts.isFunctionLike(candidate));
      for (const name of bindingNames(node.name)) {
        count(name);
        recordBinding(name, { scope, declaration: node, initializer: null });
      }
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const name of bindingNames(node.variableDeclaration.name)) {
        count(name);
        recordBinding(name, { scope: node, declaration: node, initializer: null });
      }
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      count(node.name.text);
      recordBinding(node.name.text, {
        scope: enclosingLexicalScope(node),
        declaration: node,
        initializer: null,
      });
    } else if (ts.isImportClause(node)) {
      if (node.name) {
        count(node.name.text);
        recordBinding(node.name.text, {
          scope: sourceFile,
          declaration: node,
          initializer: null,
        });
      }
      if (node.namedBindings) {
        if (ts.isNamespaceImport(node.namedBindings)) {
          count(node.namedBindings.name.text);
          recordBinding(node.namedBindings.name.text, {
            scope: sourceFile,
            declaration: node.namedBindings,
            initializer: null,
          });
        } else {
          for (const element of node.namedBindings.elements) {
            count(element.name.text);
            recordBinding(element.name.text, {
              scope: sourceFile,
              declaration: element,
              initializer: null,
            });
          }
        }
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
    ) {
      for (const name of assignedRootNames(node.left)) mutated.add(name);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      for (const name of assignedRootNames(node.operand)) mutated.add(name);
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  scopedBindingsBySource.set(sourceFile, scopedBindings);

  const strings = new Map<string, ts.Expression>();
  const objects = new Map<string, ts.ObjectLiteralExpression>();
  for (const declaration of variableDeclarations) {
    if (
      !declaration.isConst ||
      bindingCounts.get(declaration.name) !== 1 ||
      mutated.has(declaration.name)
    ) {
      continue;
    }
    strings.set(declaration.name, declaration.initializer);
    const value = unwrapExpression(declaration.initializer);
    if (ts.isObjectLiteralExpression(value)) {
      objects.set(declaration.name, value);
    }
  }

  return { strings, objects };
}

function resolveConstants(
  initializers: ReadonlyMap<string, ts.Expression>,
): Map<string, ReadonlySet<string>> {
  const constants = new Map<string, ReadonlySet<string>>();
  for (let pass = 0; pass < Math.max(2, initializers.size + 1); pass += 1) {
    let changed = false;
    for (const [name, initializer] of initializers) {
      const values = stringValues(initializer, constants);
      if (!values) continue;
      const prior = constants.get(name);
      const serialized = [...values].sort().join("\0");
      if (!prior || [...prior].sort().join("\0") !== serialized) {
        constants.set(name, values);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return constants;
}

function propertyName(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  const values = stringValues(expression.argumentExpression, constants);
  return values?.size === 1 ? [...values][0] : null;
}

function expressionPath(
  expression: ts.Expression,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  const node = unwrapExpression(expression);
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    const owner = expressionPath(node.expression, constants);
    const member = propertyName(node, constants);
    return owner && member ? `${owner}.${member}` : null;
  }
  return null;
}

function objectLiteralFor(
  expression: ts.Expression,
  objects: ReadonlyMap<string, ts.ObjectLiteralExpression>,
): ts.ObjectLiteralExpression | null {
  const node = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isIdentifier(node)) return objects.get(node.text) ?? null;
  return null;
}

type PropertyResolution =
  | { kind: "missing" }
  | { kind: "unknown" }
  | { kind: "value"; expression: ts.Expression };

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  objects: ReadonlyMap<string, ts.ObjectLiteralExpression>,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
  depth = 0,
): PropertyResolution {
  if (depth > 12) return { kind: "unknown" };
  let resolution: PropertyResolution = { kind: "missing" };

  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = objectLiteralFor(property.expression, objects);
      const nested = spread
        ? objectProperty(spread, name, objects, constants, depth + 1)
        : { kind: "unknown" as const };
      if (nested.kind !== "missing") resolution = nested;
      continue;
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === name) {
        resolution = { kind: "value", expression: property.name };
      }
      continue;
    }

    if (!ts.isPropertyAssignment(property)) {
      const key = property.name?.getText().replace(/^['"]|['"]$/g, "");
      if (key === name || ts.isComputedPropertyName(property.name)) {
        resolution = { kind: "unknown" };
      }
      continue;
    }

    const keys = ts.isComputedPropertyName(property.name)
      ? stringValues(property.name.expression, constants)
      : new Set([property.name.getText().replace(/^['"]|['"]$/g, "")]);
    if (!keys) {
      resolution = { kind: "unknown" };
    } else if (keys.size === 1 && keys.has(name)) {
      resolution = { kind: "value", expression: property.initializer };
    } else if (keys.has(name)) {
      resolution = { kind: "unknown" };
    }
  }

  return resolution;
}

function calleeOwnerAndMember(
  expression: ts.Expression,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
): { owner: ts.Expression; member: string | null } | null {
  const node = unwrapExpression(expression);
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return null;
  }
  return { owner: node.expression, member: propertyName(node, constants) };
}

function isNamedPath(path: string | null, name: string): boolean {
  return path === name || path?.endsWith(`.${name}`) === true;
}

type AliasAssignment = { name: string; value: ts.Expression };

function aliasAssignments(sourceFile: ts.SourceFile): AliasAssignment[] {
  const assignments: AliasAssignment[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      assignments.push({ name: node.name.text, value: node.initializer });
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      assignments.push({ name: node.left.text, value: node.right });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return assignments;
}

function buildAliases(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
  targetName: string,
): Set<string> {
  const aliases = new Set<string>([targetName]);
  const assignments = aliasAssignments(sourceFile);

  for (let pass = 0; pass < assignments.length + 1; pass += 1) {
    let changed = false;
    for (const assignment of assignments) {
      const path = expressionPath(assignment.value, constants);
      const node = unwrapExpression(assignment.value);
      if (
        isNamedPath(path, targetName) ||
        (ts.isIdentifier(node) && aliases.has(node.text))
      ) {
        if (!aliases.has(assignment.name)) {
          aliases.add(assignment.name);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return aliases;
}

function isAliasedExpression(
  expression: ts.Expression,
  aliases: ReadonlySet<string>,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
  targetName: string,
): boolean {
  const node = unwrapExpression(expression);
  if (ts.isIdentifier(node) && aliases.has(node.text)) return true;
  return isNamedPath(expressionPath(node, constants), targetName);
}

function isAliasedMember(
  expression: ts.Expression,
  ownerAliases: ReadonlySet<string>,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
  ownerName: string,
  memberName: string,
): boolean {
  const node = unwrapExpression(expression);
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return false;
  }
  return (
    propertyName(node, constants) === memberName &&
    isAliasedExpression(node.expression, ownerAliases, constants, ownerName)
  );
}

function buildCallableMemberAliases(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
  ownerAliases: ReadonlySet<string>,
  ownerName: string,
  memberName: string,
): Set<string> {
  const aliases = new Set<string>([memberName]);
  const assignments = aliasAssignments(sourceFile);

  const isMemberValue = (value: ts.Expression): boolean => {
    const node = unwrapExpression(value);
    if (isAliasedMember(node, ownerAliases, constants, ownerName, memberName)) {
      return true;
    }
    if (ts.isCallExpression(node)) {
      const callee = calleeOwnerAndMember(node.expression, constants);
      return (
        callee?.member === "bind" &&
        isAliasedMember(
          callee.owner,
          ownerAliases,
          constants,
          ownerName,
          memberName,
        )
      );
    }
    return ts.isIdentifier(node) && aliases.has(node.text);
  };

  for (let pass = 0; pass < assignments.length + 1; pass += 1) {
    let changed = false;
    for (const assignment of assignments) {
      if (isMemberValue(assignment.value) && !aliases.has(assignment.name)) {
        aliases.add(assignment.name);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isAliasedExpression(node.initializer, ownerAliases, constants, ownerName)
    ) {
      for (const element of node.name.elements) {
        const sourceName = element.propertyName?.getText() ?? element.name.getText();
        if (sourceName.replace(/^['"]|['"]$/g, "") === memberName) {
          for (const name of bindingNames(element.name)) aliases.add(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return aliases;
}

function expressionText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 240);
}

function fetchMethods(
  options: ts.Expression | undefined,
  objects: ReadonlyMap<string, ts.ObjectLiteralExpression>,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> | null {
  if (!options) return new Set(["GET"]);
  const object = objectLiteralFor(options, objects);
  if (!object) return null;
  const method = objectProperty(object, "method", objects, constants);
  if (method.kind === "missing") return new Set(["GET"]);
  if (method.kind === "unknown") return null;
  const values = stringValues(method.expression, constants);
  return values
    ? new Set([...values].map((value) => value.trim().toUpperCase()))
    : null;
}

function isFetchExpression(
  expression: ts.Expression,
  fetchAliases: ReadonlySet<string>,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const node = unwrapExpression(expression);
  return (
    (ts.isIdentifier(node) && fetchAliases.has(node.text)) ||
    isNamedPath(expressionPath(expression, constants), "fetch")
  );
}

function isXmlHttpRequestConstructor(
  expression: ts.Expression,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const node = unwrapExpression(expression);
  return (
    ts.isNewExpression(node) &&
    isNamedPath(expressionPath(node.expression, constants), "XMLHttpRequest")
  );
}

function xmlHttpRequestAliases(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const aliases = new Set<string>();
  for (const assignment of aliasAssignments(sourceFile)) {
    if (isXmlHttpRequestConstructor(assignment.value, constants)) {
      aliases.add(assignment.name);
    }
  }
  return aliases;
}

function isAssignmentLeft(node: ts.Expression): boolean {
  const parent = node.parent;
  return (
    ts.isBinaryExpression(parent) &&
    ASSIGNMENT_OPERATORS.has(parent.operatorToken.kind) &&
    unwrapExpression(parent.left) === node
  );
}

function isCallCallee(node: ts.Expression): boolean {
  const parent = node.parent;
  return ts.isCallExpression(parent) && unwrapExpression(parent.expression) === node;
}

function sourceFileFor(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "kids-output.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}

export function analyzeModuleDependencies(
  source: string,
): ModuleDependencyAnalysis {
  const sourceFile = sourceFileFor(source);
  const initializers = collectInitializers(sourceFile);
  const constants = resolveConstants(initializers.strings);
  const specifiers = new Set<string>();
  const unresolved: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const values = stringValues(node.arguments[0], constants);
      if (values && values.size > 0) {
        for (const value of values) specifiers.add(value);
      } else {
        unresolved.push(expressionText(node, sourceFile));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { specifiers: [...specifiers].sort(), unresolved: unresolved.sort() };
}

export function analyzeClientCode(source: string): ClientCodeAnalysis {
  const sourceFile = sourceFileFor(source);
  const initializers = collectInitializers(sourceFile);
  const constants = resolveConstants(initializers.strings);
  const storageAliases = buildAliases(sourceFile, constants, "localStorage");
  const documentAliases = buildAliases(sourceFile, constants, "document");
  const navigatorAliases = buildAliases(sourceFile, constants, "navigator");
  const sessionStorageAliases = buildAliases(
    sourceFile,
    constants,
    "sessionStorage",
  );
  const indexedDbAliases = buildAliases(sourceFile, constants, "indexedDB");
  const fetchAliases = buildAliases(sourceFile, constants, "fetch");
  const beaconAliases = buildCallableMemberAliases(
    sourceFile,
    constants,
    navigatorAliases,
    "navigator",
    "sendBeacon",
  );
  const xhrAliases = xmlHttpRequestAliases(sourceFile, constants);
  const forbiddenApis = new Set<string>();
  const storageAccesses: StorageAccess[] = [];
  const networkWrites: NetworkWrite[] = [];

  const addForbiddenPath = (expression: ts.Expression): void => {
    const node = unwrapExpression(expression);
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const member = propertyName(node, constants);
      if (
        member === "cookie" &&
        isAliasedExpression(
          node.expression,
          documentAliases,
          constants,
          "document",
        )
      ) {
        forbiddenApis.add("document.cookie");
      }
      if (
        member === "sendBeacon" &&
        isAliasedExpression(
          node.expression,
          navigatorAliases,
          constants,
          "navigator",
        )
      ) {
        forbiddenApis.add("sendBeacon");
      }
      if (
        member === null &&
        isAliasedExpression(
          node.expression,
          documentAliases,
          constants,
          "document",
        )
      ) {
        forbiddenApis.add("document[computed]");
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      addForbiddenPath(node);
      if (
        isAliasedExpression(
          node,
          sessionStorageAliases,
          constants,
          "sessionStorage",
        )
      ) {
        forbiddenApis.add("sessionStorage");
      }
      if (
        isAliasedExpression(node, indexedDbAliases, constants, "indexedDB")
      ) {
        forbiddenApis.add("indexedDB");
      }
      const member = propertyName(node, constants);
      if (
        isAliasedExpression(
          node.expression,
          storageAliases,
          constants,
          "localStorage",
        ) &&
        !isAssignmentLeft(node) &&
        !isCallCallee(node) &&
        (!member ||
          (!STORAGE_METHODS.has(member) &&
            !STORAGE_NON_KEY_MEMBERS.has(member)))
      ) {
        storageAccesses.push({
          operation: "get",
          keys: member ? [member] : null,
          values: null,
          expression: expressionText(node, sourceFile),
        });
      }
    } else if (ts.isIdentifier(node)) {
      if (sessionStorageAliases.has(node.text)) {
        forbiddenApis.add("sessionStorage");
      }
      if (indexedDbAliases.has(node.text)) forbiddenApis.add("indexedDB");
    }

    if (ts.isCallExpression(node)) {
      const callText = expressionText(node, sourceFile);
      const calleeNode = unwrapExpression(node.expression);
      const callee = calleeOwnerAndMember(node.expression, constants);
      if (
        (ts.isIdentifier(calleeNode) && beaconAliases.has(calleeNode.text)) ||
        (callee?.member === "sendBeacon" &&
          isAliasedExpression(
            callee.owner,
            navigatorAliases,
            constants,
            "navigator",
          ))
      ) {
        forbiddenApis.add("sendBeacon");
      }

      if (
        callee &&
        isAliasedExpression(
          callee.owner,
          storageAliases,
          constants,
          "localStorage",
        )
      ) {
        const method = callee.member;
        if (method && STORAGE_METHODS.has(method)) {
          const keys = stringValues(node.arguments[0], constants);
          const values =
            method === "setItem"
              ? stringValues(node.arguments[1], constants)
              : null;
          storageAccesses.push({
            operation:
              method === "getItem"
                ? "get"
                : method === "removeItem"
                  ? "remove"
                  : "set",
            keys: keys ? [...keys] : null,
            values: method === "setItem" && values ? [...values] : null,
            expression: callText,
          });
        } else if (!method || !STORAGE_NON_KEY_MEMBERS.has(method)) {
          storageAccesses.push({
            operation: "unknown",
            keys: null,
            values: null,
            expression: callText,
          });
        }
      }

      if (isFetchExpression(node.expression, fetchAliases, constants)) {
        const methods = fetchMethods(
          node.arguments[1],
          initializers.objects,
          constants,
        );
        if (
          !methods ||
          [...methods].some((method) => WRITE_METHODS.has(method))
        ) {
          const targets = stringValues(node.arguments[0], constants);
          networkWrites.push({
            api: "fetch",
            methods: methods ? [...methods] : null,
            targets: targets ? [...targets] : null,
            expression: callText,
          });
        }
      }

      if (callee?.member === "open") {
        const owner = unwrapExpression(callee.owner);
        const isXhr = ts.isIdentifier(owner) && xhrAliases.has(owner.text);
        if (isXhr) {
          const methods = stringValues(node.arguments[0], constants);
          const normalized = methods
            ? new Set(
                [...methods].map((method) => method.trim().toUpperCase()),
              )
            : null;
          if (
            !normalized ||
            [...normalized].some((method) => WRITE_METHODS.has(method))
          ) {
            const targets = stringValues(node.arguments[1], constants);
            networkWrites.push({
              api: "XMLHttpRequest",
              methods: normalized ? [...normalized] : null,
              targets: targets ? [...targets] : null,
              expression: callText,
            });
          }
        }
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = unwrapExpression(node.left);
      if (
        ts.isPropertyAccessExpression(left) ||
        ts.isElementAccessExpression(left)
      ) {
        if (
          isAliasedExpression(
            left.expression,
            storageAliases,
            constants,
            "localStorage",
          )
        ) {
          const key = propertyName(left, constants);
          const values = stringValues(node.right, constants);
          storageAccesses.push({
            operation: "property-write",
            keys: key ? [key] : null,
            values: values ? [...values] : null,
            expression: expressionText(node, sourceFile),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    forbiddenApis: [...forbiddenApis].sort(),
    storageAccesses,
    networkWrites,
  };
}

export function storagePolicyViolations(
  accesses: readonly StorageAccess[],
  policy: StoragePolicy,
): string[] {
  const violations: string[] = [];
  for (const access of accesses) {
    if (!access.keys || access.keys.length === 0) {
      violations.push(`unresolved storage key: ${access.expression}`);
      continue;
    }
    for (const key of access.keys) {
      const allowedValues = policy.get(key);
      if (!allowedValues) {
        violations.push(
          `unreviewed storage key ${JSON.stringify(key)}: ${access.expression}`,
        );
        continue;
      }
      if (
        access.operation !== "set" &&
        access.operation !== "property-write"
      ) {
        continue;
      }
      if (!access.values || access.values.length === 0) {
        violations.push(
          `unresolved value for ${JSON.stringify(key)}: ${access.expression}`,
        );
        continue;
      }
      for (const value of access.values) {
        if (!allowedValues.has(value)) {
          violations.push(
            `unreviewed value ${JSON.stringify(value)} for ${JSON.stringify(key)}: ${access.expression}`,
          );
        }
      }
    }
  }
  return violations.sort();
}
