// Record possible readers, including Firebase parameter declarations. An
// opaque reference to the environment prevents proving the absence of readers.
export function functionRuntimeReads(tree, ts) {
  const keys = new Set();
  const aliases = new Set();
  const sdkParameter = /^define(?:Boolean|Float|Int|JsonSecret|List|Secret|String)$/;
  let unknown = false;
  const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  const member = (node, base) => node?.expression === base
    ? ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) ? literal(node.argumentExpression) : undefined
    : undefined;
  const record = key => {
    if (/^[A-Z][A-Z0-9_]+$/.test(key ?? "")) keys.add(key);
  };
  const visit = node => {
    if (ts.isIdentifier(node) && sdkParameter.test(node.text)) {
      const use = node.parent;
      const call = ts.isPropertyAccessExpression(use) && use.name === node ? use.parent : use;
      if (ts.isCallExpression(call) && (call.expression === node || call.expression === use)) {
        if (literal(call.arguments[0]) === undefined) unknown = true;
      } else if (!(use.name === node && (ts.isBindingElement(use) || ts.isImportSpecifier(use)) && !use.propertyName)) {
        unknown = true;
      }
    }
    if (ts.isIdentifier(node) && node.text === "process") {
      const access = node.parent;
      const property = member(access, node);
      if (property === "env") {
        const use = access.parent;
        const key = member(use, access);
        if (key !== undefined) record(key);
        else if ((ts.isParameter(use) || ts.isBindingElement(use)) && use.initializer === access && ts.isIdentifier(use.name)) {
          aliases.add(use.name.text);
        } else unknown = true;
      } else if (!["argv", "cwd", "exit", "exitCode", "pid", "stderr", "stdout", "versions"].includes(property)) {
        unknown = true;
      }
    }
    if (ts.isIdentifier(node) && ["global", "globalThis"].includes(node.text)) {
      // Current callers use only these properties of the global object.
      if (!["fetch", "crypto"].includes(member(node.parent, node))) unknown = true;
    }
    if (literal(node) === "process" || literal(node) === "node:process") unknown = true;
    record(literal(node));
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (aliases.size) {
    const visitAlias = node => {
      if (ts.isIdentifier(node) && aliases.has(node.text)) {
        const use = node.parent;
        const key = member(use, node);
        if (key !== undefined) record(key);
        else if (!(use.name === node && ((ts.isParameter(use) || ts.isBindingElement(use)) ||
            ts.isPropertyAccessExpression(use) || ts.isPropertyAssignment(use)))) unknown = true;
      }
      ts.forEachChild(node, visitAlias);
    };
    visitAlias(tree);
  }
  return { keys: [...keys], unknown };
}
