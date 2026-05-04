#!/usr/bin/env node

import ts from "typescript";
import { bundledPluginCallsite } from "./lib/bundled-plugin-paths.mjs";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import {
  collectCallExpressionLines,
  runAsScript,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src", "extensions"];

// Managed-proxy raw-socket classification allowlist.
// Each entry is intentionally a concrete callsite so new raw socket egress fails until reviewed.
const allowedRawSocketCallsites = new Set([
  // Local Gateway run loop readiness probe.
  "src/cli/gateway-cli/run-loop.ts:46",

  // Local loopback readiness probe for SSH tunnels.
  "src/infra/ssh-tunnel.ts:80",

  // Local gateway lock probe.
  "src/infra/gateway-lock.ts:147",

  // Local Unix-domain socket IPC client.
  "src/infra/jsonl-socket.ts:35",

  // Managed HTTP CONNECT tunnel helper used by APNs and proxy validation.
  "src/infra/net/http-connect-tunnel.ts:117",
  "src/infra/net/http-connect-tunnel.ts:123",
  "src/infra/net/http-connect-tunnel.ts:268",

  // APNs HTTP/2 wrapper: direct only when managed proxy is inactive; tunneled when active.
  "src/infra/push-apns-http2.ts:74",
  "src/infra/push-apns-http2.ts:85",

  // Debug proxy CONNECT internals. PR #77010 guards this path while managed proxy mode is active.
  "src/proxy-capture/proxy-server.ts:266",

  // QA-lab tunnel/capture helpers used for local lab diagnostics.
  bundledPluginCallsite("qa-lab", "src/lab-server-capture.ts", 99),
  bundledPluginCallsite("qa-lab", "src/lab-server-ui.ts", 207),
  bundledPluginCallsite("qa-lab", "src/lab-server-ui.ts", 212),

  // IRC is a raw TCP/TLS channel and is documented as outside managed HTTP proxy coverage.
  bundledPluginCallsite("irc", "src/client.ts", 124),
  bundledPluginCallsite("irc", "src/client.ts", 129),
]);

const rawModuleSpecifiers = new Map([
  ["node:net", "net"],
  ["net", "net"],
  ["node:tls", "tls"],
  ["tls", "tls"],
  ["node:http2", "http2"],
  ["http2", "http2"],
]);

function unwrapInitializer(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isAwaitExpression(unwrapped)) {
    return unwrapExpression(unwrapped.expression);
  }
  return unwrapped;
}

function bindRawModuleDestructureAliases(bindingName, moduleKind, aliases) {
  if (!ts.isObjectBindingPattern(bindingName)) {
    return;
  }
  for (const element of bindingName.elements) {
    if (!ts.isIdentifier(element.name)) {
      continue;
    }
    const importedName =
      element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : element.name.text;
    if (
      importedName === "connect" ||
      importedName === "createConnection" ||
      importedName === "Socket"
    ) {
      aliases.set(element.name.text, `${moduleKind}.${importedName}`);
    }
  }
}

function collectSocketInstanceAliases(sourceFile, rawAliases) {
  const socketAliases = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (isSocketConstructorExpression(node.initializer, rawAliases)) {
        socketAliases.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return socketAliases;
}

function collectRawModuleAliases(sourceFile) {
  const aliases = new Map();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleKind = rawModuleSpecifiers.get(node.moduleSpecifier.text);
      const clause = node.importClause;
      if (moduleKind && clause) {
        if (clause.name) {
          aliases.set(clause.name.text, moduleKind);
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          aliases.set(clause.namedBindings.name.text, moduleKind);
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const specifier of clause.namedBindings.elements) {
            const importedName = (specifier.propertyName ?? specifier.name).text;
            if (
              importedName === "connect" ||
              importedName === "createConnection" ||
              importedName === "Socket"
            ) {
              aliases.set(specifier.name.text, `${moduleKind}.${importedName}`);
            }
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapInitializer(node.initializer);
      if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(unwrapExpression(initializer.expression)) &&
        unwrapExpression(initializer.expression).text === "require" &&
        initializer.arguments.length === 1 &&
        ts.isStringLiteral(initializer.arguments[0])
      ) {
        const moduleKind = rawModuleSpecifiers.get(initializer.arguments[0].text);
        if (moduleKind) {
          if (ts.isIdentifier(node.name)) {
            aliases.set(node.name.text, moduleKind);
          } else {
            bindRawModuleDestructureAliases(node.name, moduleKind, aliases);
          }
        }
      }
      if (
        ts.isCallExpression(initializer) &&
        initializer.expression.kind === ts.SyntaxKind.ImportKeyword &&
        initializer.arguments.length === 1 &&
        ts.isStringLiteral(initializer.arguments[0])
      ) {
        const moduleKind = rawModuleSpecifiers.get(initializer.arguments[0].text);
        if (moduleKind) {
          if (ts.isIdentifier(node.name)) {
            aliases.set(node.name.text, moduleKind);
          } else {
            bindRawModuleDestructureAliases(node.name, moduleKind, aliases);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function aliasKind(expression, aliases) {
  const receiver = unwrapExpression(expression);
  return ts.isIdentifier(receiver) ? aliases.get(receiver.text) : undefined;
}

function isRawModuleAlias(expression, aliases, expectedKinds) {
  const kind = aliasKind(expression, aliases);
  return expectedKinds.has(kind);
}

function isSocketConstructorExpression(expression, aliases) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isNewExpression(unwrapped)) {
    return false;
  }
  const callee = unwrapExpression(unwrapped.expression);
  if (aliasKind(callee, aliases) === "net.Socket") {
    return true;
  }
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "Socket") {
    return false;
  }
  return isRawModuleAlias(callee.expression, aliases, new Set(["net"]));
}

function rawSocketCallee(expression, aliases, socketAliases = new Set()) {
  const callee = unwrapExpression(expression);
  if (ts.isIdentifier(callee)) {
    const kind = aliasKind(callee, aliases);
    return kind === "net.connect" ||
      kind === "tls.connect" ||
      kind === "http2.connect" ||
      kind === "net.createConnection" ||
      kind === "tls.createConnection"
      ? callee
      : null;
  }
  if (!ts.isPropertyAccessExpression(callee)) {
    return null;
  }
  if (
    callee.name.text === "connect" &&
    isRawModuleAlias(callee.expression, aliases, new Set(["net", "tls", "http2"]))
  ) {
    return callee;
  }
  if (
    callee.name.text === "createConnection" &&
    isRawModuleAlias(callee.expression, aliases, new Set(["net", "tls"]))
  ) {
    return callee;
  }
  if (callee.name.text === "connect" && isSocketConstructorExpression(callee.expression, aliases)) {
    return callee;
  }
  if (
    callee.name.text === "connect" &&
    ts.isIdentifier(unwrapExpression(callee.expression)) &&
    socketAliases.has(unwrapExpression(callee.expression).text)
  ) {
    return callee;
  }
  return null;
}

export function findRawSocketClientCallLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const aliases = collectRawModuleAliases(sourceFile);
  const socketAliases = collectSocketInstanceAliases(sourceFile, aliases);
  return collectCallExpressionLines(ts, sourceFile, (node) =>
    rawSocketCallee(node.expression, aliases, socketAliases),
  );
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
    findCallLines: findRawSocketClientCallLines,
    skipRelativePath: (relPath) => relPath.includes("/test-support/"),
    allowCallsite: (callsite) => allowedRawSocketCallsites.has(callsite),
    header: "Found unclassified raw socket client calls:",
    footer:
      "Classify raw net/tls/http2 egress as managed/proxied, local-only, diagnostic guarded, or documented unsupported before adding callsites.",
  });
}

runAsScript(import.meta.url, main);
