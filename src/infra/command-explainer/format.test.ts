import { describe, expect, it } from "vitest";
import { explainShellCommand } from "./extract.js";
import { formatCommandExplanationHighlights, formatCommandExplanationLines } from "./format.js";
import type { CommandExplanation } from "./types.js";

const span = {
  startIndex: 0,
  endIndex: 1,
  startPosition: { row: 0, column: 0 },
  endPosition: { row: 0, column: 1 },
};

describe("formatCommandExplanationLines", () => {
  it("summarizes top-level commands and inline eval", () => {
    const explanation: CommandExplanation = {
      ok: true,
      source: 'ls | grep "stuff" | python -c \'print("hi")\'',
      shapes: ["pipeline"],
      topLevelCommands: [
        { context: "top-level", executable: "ls", argv: ["ls"], text: "ls", span },
        {
          context: "top-level",
          executable: "grep",
          argv: ["grep", "stuff"],
          text: 'grep "stuff"',
          span,
        },
        {
          context: "top-level",
          executable: "python",
          argv: ["python", "-c", 'print("hi")'],
          text: "python -c 'print(\"hi\")'",
          span,
        },
      ],
      nestedCommands: [],
      risks: [
        {
          kind: "inline-eval",
          command: "python",
          flag: "-c",
          text: "python -c 'print(\"hi\")'",
          span,
        },
      ],
    };

    expect(formatCommandExplanationLines(explanation)).toEqual([
      "Risks:",
      "• python -c can run arbitrary code on your computer.",
    ]);
  });

  it("summarizes recursive carrier commands with plain risk copy", () => {
    const explanation: CommandExplanation = {
      ok: true,
      source: "find ... -exec sh -c 'echo; node -e'",
      shapes: [],
      topLevelCommands: [
        { context: "top-level", executable: "find", argv: ["find"], text: "find", span },
      ],
      nestedCommands: [
        { context: "wrapper-payload", executable: "echo", argv: ["echo"], text: "echo", span },
        {
          context: "wrapper-payload",
          executable: "node",
          argv: ["node", "-e", "1"],
          text: "node -e 1",
          span,
        },
      ],
      risks: [
        { kind: "command-carrier", command: "find", flag: "-exec", text: "find -exec", span },
        { kind: "inline-eval", command: "node", flag: "-e", text: "node -e 1", span },
      ],
    };

    expect(formatCommandExplanationLines(explanation)).toEqual([
      "Risks:",
      "• find -exec can run another command for every matching file.",
      "• node -e can run arbitrary code on your computer.",
    ]);
    expect(
      formatCommandExplanationHighlights(explanation).map((highlight) => ({
        kind: highlight.kind,
        severity: highlight.severity,
      })),
    ).toEqual([
      { kind: "command", severity: "info" },
      { kind: "command", severity: "info" },
      { kind: "command", severity: "info" },
      { kind: "risk", severity: "warning" },
      { kind: "risk", severity: "danger" },
    ]);
  });

  it("formats mixed pipeline and nested find exec with separate sections", async () => {
    const explanation = await explainShellCommand(
      'find . -maxdepth 2 -name "*.ts" -exec sh -c \'echo checking "$1"; node -e "console.log(process.argv[1])" "$1"\' sh {} \\; | grep checking | python -c \'print("ok")\'',
    );

    expect(formatCommandExplanationLines(explanation)).toEqual([
      "Risks:",
      "• find -exec can run another command for every matching file.",
      "• node -e can run arbitrary code on your computer.",
      "• python -c can run arbitrary code on your computer.",
    ]);
    expect(formatCommandExplanationHighlights(explanation)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "risk", severity: "warning" }),
        expect.objectContaining({ kind: "risk", severity: "danger" }),
      ]),
    );
  });

  it("summarizes nested command substitution without raw payloads", () => {
    const explanation: CommandExplanation = {
      ok: true,
      source: "echo $(whoami)",
      shapes: [],
      topLevelCommands: [
        {
          context: "top-level",
          executable: "echo",
          argv: ["echo", "$(...)"],
          text: "echo $(whoami)",
          span,
        },
      ],
      nestedCommands: [
        {
          context: "command-substitution",
          executable: "whoami",
          argv: ["whoami"],
          text: "whoami",
          span,
        },
      ],
      risks: [{ kind: "command-substitution", text: "$(whoami)", span }],
    };

    expect(formatCommandExplanationLines(explanation)).toEqual([
      "Risks:",
      "• $(...) runs a hidden command first.",
    ]);
  });
});
