import { describe, expect, it } from "vitest";
import { buildPendingApprovalView } from "./approval-view-model.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";

describe("buildPendingApprovalView", () => {
  it("passes command explanation lines through exec approval views", () => {
    const request: ExecApprovalRequest = {
      id: "approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: 'ls | grep "stuff" | python -c \'print("hi")\'',
        host: "node",
        ask: "always",
        commandExplanationLines: [
          "Runs 3 programs: ls, grep, and python.",
          "Warning: python -c runs inline code.",
        ],
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view.approvalKind).toBe("exec");
    if (view.approvalKind !== "exec") {
      throw new Error("expected exec approval view");
    }
    expect(view.commandExplanationLines).toEqual([
      "Runs 3 programs: ls, grep, and python.",
      "Warning: python -c runs inline code.",
    ]);
  });
});
