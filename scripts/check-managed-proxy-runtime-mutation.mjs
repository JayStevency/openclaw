#!/usr/bin/env node

import ts from "typescript";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import { runAsScript, toLine, unwrapExpression } from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src", "extensions"];

const allowedManagedProxyRuntimeMutationCallsites = new Set([
  // Canonical managed proxy lifecycle owns process proxy env/global-agent mutation.
  "src/infra/net/proxy/proxy-lifecycle.ts:114",
  "src/infra/net/proxy/proxy-lifecycle.ts:117",
  "src/infra/net/proxy/proxy-lifecycle.ts:119",
  "src/infra/net/proxy/proxy-lifecycle.ts:120",
  "src/infra/net/proxy/proxy-lifecycle.ts:121",
  "src/infra/net/proxy/proxy-lifecycle.ts:123",
  "src/infra/net/proxy/proxy-lifecycle.ts:131",
  "src/infra/net/proxy/proxy-lifecycle.ts:133",
  "src/infra/net/proxy/proxy-lifecycle.ts:146",
  "src/infra/net/proxy/proxy-lifecycle.ts:147",
  "src/infra/net/proxy/proxy-lifecycle.ts:148",
  "src/infra/net/proxy/proxy-lifecycle.ts:199",
  "src/infra/net/proxy/proxy-lifecycle.ts:200",
  "src/infra/net/proxy/proxy-lifecycle.ts:201",
  "src/infra/net/proxy/proxy-lifecycle.ts:312",
  "src/infra/net/proxy/proxy-lifecycle.ts:313",
  "src/infra/net/proxy/proxy-lifecycle.ts:314",
  "src/infra/net/proxy/proxy-lifecycle.ts:315",
  "src/infra/net/proxy/proxy-lifecycle.ts:316",
  "src/infra/net/proxy/proxy-lifecycle.ts:317",
  "src/infra/net/proxy/proxy-lifecycle.ts:318",
  "src/infra/net/proxy/proxy-lifecycle.ts:319",
  "src/infra/net/proxy/proxy-lifecycle.ts:329",
  "src/infra/net/proxy/proxy-lifecycle.ts:330",
  "src/infra/net/proxy/proxy-lifecycle.ts:331",
  "src/infra/net/proxy/proxy-lifecycle.ts:332",
  "src/infra/net/proxy/proxy-lifecycle.ts:333",
  "src/infra/net/proxy/proxy-lifecycle.ts:334",
  "src/infra/net/proxy/proxy-lifecycle.ts:335",
  "src/infra/net/proxy/proxy-lifecycle.ts:336",
  "src/infra/net/proxy/proxy-lifecycle.ts:369",
  "src/infra/net/proxy/proxy-lifecycle.ts:376",
  "src/infra/net/proxy/proxy-lifecycle.ts:484",
  "src/infra/net/proxy/proxy-lifecycle.ts:507",
  "src/infra/net/proxy/proxy-lifecycle.ts:508",
  "src/infra/net/proxy/proxy-lifecycle.ts:515",
  "src/infra/net/proxy/proxy-lifecycle.ts:516",

  // Browser CDP loopback control-plane helper leases NO_PROXY only for localhost/loopback CDP URLs.
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:87",
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:88",
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:120",
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:122",
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:125",
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:127",
]);

const forbiddenEnvKeys = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "GLOBAL_AGENT_HTTP_PROXY",
  "GLOBAL_AGENT_HTTPS_PROXY",
  "GLOBAL_AGENT_NO_PROXY",
  "GLOBAL_AGENT_FORCE_GLOBAL_AGENT",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_LOOPBACK_MODE",
]);

const forbiddenGlobalAgentKeys = new Set(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);

function stringLiteralText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function isGlobalIdentifier(node) {
  const unwrapped = unwrapExpression(node);
  return (
    ts.isIdentifier(unwrapped) && (unwrapped.text === "global" || unwrapped.text === "globalThis")
  );
}

function processEnvExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === "env") {
    const base = unwrapExpression(unwrapped.expression);
    return ts.isIdentifier(base) && base.text === "process" ? unwrapped : null;
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const key = stringLiteralText(unwrapExpression(unwrapped.argumentExpression));
    if (key !== "env") {
      return null;
    }
    const base = unwrapExpression(unwrapped.expression);
    return ts.isIdentifier(base) && base.text === "process" ? unwrapped : null;
  }
  return null;
}

function collectStringArrays(sourceFile) {
  const arrays = new Map();
  for (let pass = 0; pass < 4; pass += 1) {
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (ts.isArrayLiteralExpression(initializer)) {
          const values = [];
          let complete = true;
          for (const element of initializer.elements) {
            const unwrapped = unwrapExpression(element);
            if (
              ts.isSpreadElement(unwrapped) &&
              ts.isIdentifier(unwrapExpression(unwrapped.expression))
            ) {
              const nested = arrays.get(unwrapExpression(unwrapped.expression).text);
              if (nested) {
                values.push(...nested);
              } else {
                complete = false;
              }
              continue;
            }
            const literal = stringLiteralText(unwrapped);
            if (literal) {
              values.push(literal);
            } else {
              complete = false;
            }
          }
          if (complete) {
            const previous = arrays.get(node.name.text);
            const sameValues = previous && previous.join("\0") === values.join("\0");
            if (!sameValues) {
              arrays.set(node.name.text, values);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return arrays;
}

function collectForbiddenKeyArrays(sourceFile) {
  const stringArrays = collectStringArrays(sourceFile);
  const arrays = new Set();
  for (const [name, values] of stringArrays) {
    if (values.some((key) => forbiddenEnvKeys.has(key))) {
      arrays.add(name);
    }
  }
  return arrays;
}

function collectForbiddenKeyVariables(sourceFile, forbiddenKeyArrays) {
  const variables = new Set();
  const visit = (node) => {
    if (ts.isForOfStatement(node)) {
      const expression = unwrapExpression(node.expression);
      if (ts.isIdentifier(expression) && forbiddenKeyArrays.has(expression.text)) {
        const initializer = node.initializer;
        if (ts.isVariableDeclarationList(initializer)) {
          for (const declaration of initializer.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              variables.add(declaration.name.text);
            }
          }
        } else if (ts.isIdentifier(initializer)) {
          variables.add(initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return variables;
}

function envKeyExpressionIsForbidden(argumentExpression, context) {
  const keyExpression = unwrapExpression(argumentExpression);
  const literalKey = stringLiteralText(keyExpression);
  if (literalKey) {
    return forbiddenEnvKeys.has(literalKey);
  }
  return ts.isIdentifier(keyExpression) && context.forbiddenKeyVariables.has(keyExpression.text);
}

function envMutationTarget(expression, context) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped) && processEnvExpression(unwrapped.expression)) {
    return forbiddenEnvKeys.has(unwrapped.name.text) ? unwrapped : null;
  }
  if (ts.isElementAccessExpression(unwrapped) && processEnvExpression(unwrapped.expression)) {
    return envKeyExpressionIsForbidden(unwrapped.argumentExpression, context) ? unwrapped : null;
  }
  return null;
}

function globalAgentExpression(expression, context = { globalAgentAliases: new Set() }) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped) && context.globalAgentAliases.has(unwrapped.text)) {
    return unwrapped;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const receiver = unwrapExpression(unwrapped.expression);
    if (unwrapped.name.text === "GLOBAL_AGENT" && isGlobalIdentifier(receiver)) {
      return unwrapped;
    }
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const receiver = unwrapExpression(unwrapped.expression);
    const key = stringLiteralText(unwrapExpression(unwrapped.argumentExpression));
    if (key === "GLOBAL_AGENT" && isGlobalIdentifier(receiver)) {
      return unwrapped;
    }
  }
  return null;
}

function collectGlobalAgentAliases(sourceFile) {
  const aliases = new Set();
  const emptyContext = { globalAgentAliases: new Set() };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (globalAgentExpression(node.initializer, emptyContext)) {
        aliases.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function globalAgentMutationTarget(expression, context) {
  const unwrapped = unwrapExpression(expression);
  if (globalAgentExpression(unwrapped, context)) {
    return unwrapped;
  }
  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    globalAgentExpression(unwrapped.expression, context)
  ) {
    return forbiddenGlobalAgentKeys.has(unwrapped.name.text) ? unwrapped : null;
  }
  if (
    ts.isElementAccessExpression(unwrapped) &&
    globalAgentExpression(unwrapped.expression, context)
  ) {
    const key = stringLiteralText(unwrapExpression(unwrapped.argumentExpression));
    return key && forbiddenGlobalAgentKeys.has(key) ? unwrapped : null;
  }
  return null;
}

function mutationTarget(expression, context) {
  return envMutationTarget(expression, context) ?? globalAgentMutationTarget(expression, context);
}

function deleteTarget(expression, context) {
  const unwrapped = unwrapExpression(expression);
  return ts.isDeleteExpression(unwrapped) ? mutationTarget(unwrapped.expression, context) : null;
}

function assignmentTarget(expression, context) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isBinaryExpression(unwrapped) && ts.isAssignmentOperator(unwrapped.operatorToken.kind)) {
    return mutationTarget(unwrapped.left, context);
  }
  return null;
}

function mutatingCallTarget(expression, context) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isCallExpression(unwrapped)) {
    return null;
  }
  const callee = unwrapExpression(unwrapped.expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return null;
  }
  const method = callee.name.text;
  if (method !== "defineProperty" && method !== "assign") {
    return null;
  }
  const receiver = unwrapExpression(callee.expression);
  if (!ts.isIdentifier(receiver) || receiver.text !== "Object") {
    return null;
  }
  const first = unwrapped.arguments[0] ? unwrapExpression(unwrapped.arguments[0]) : null;
  if (!first) {
    return null;
  }
  if (method === "assign") {
    return globalAgentExpression(first, context) ?? processEnvExpression(first);
  }
  const keyArg = unwrapped.arguments[1]
    ? stringLiteralText(unwrapExpression(unwrapped.arguments[1]))
    : null;
  if (keyArg && processEnvExpression(first)) {
    return forbiddenEnvKeys.has(keyArg) ? first : null;
  }
  if (keyArg && globalAgentExpression(first, context)) {
    return forbiddenGlobalAgentKeys.has(keyArg) ? first : null;
  }
  return null;
}

export function findManagedProxyRuntimeMutationLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const context = {
    forbiddenKeyVariables: collectForbiddenKeyVariables(
      sourceFile,
      collectForbiddenKeyArrays(sourceFile),
    ),
    globalAgentAliases: collectGlobalAgentAliases(sourceFile),
  };
  const lines = [];
  const visit = (node) => {
    const match =
      assignmentTarget(node, context) ??
      deleteTarget(node, context) ??
      mutatingCallTarget(node, context);
    if (match) {
      lines.push(toLine(sourceFile, match));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

export async function main() {
  await runCallsiteGuard({
    importMetaUrl: import.meta.url,
    sourceRoots,
    extraTestSuffixes: [
      ".browser.test.ts",
      ".node.test.ts",
      ".live.test.ts",
      ".e2e.test.ts",
      ".integration.test.ts",
    ],
    findCallLines: findManagedProxyRuntimeMutationLines,
    allowCallsite: (callsite) => allowedManagedProxyRuntimeMutationCallsites.has(callsite),
    header: "Found unmanaged managed-proxy runtime mutation:",
    footer:
      "Only proxy lifecycle code may mutate GLOBAL_AGENT or proxy-related process.env runtime state.",
  });
}

runAsScript(import.meta.url, main);
