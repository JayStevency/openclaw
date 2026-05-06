/**
 * Betman game schedule scraper (scheduled broadcast).
 * Fetches game schedules from betman.co.kr and outputs Discord-formatted message.
 * Uses deduplication to avoid sending duplicate messages.
 *
 * Usage: bun scripts/betman-schedule.ts
 * Exits 0 with output if there are changes to send, 2 if no changes (skip).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchBetmanSchedule } from "../src/auto-reply/reply/commands-sim.js";

const STATE_DIR = join(homedir(), ".openclaw");
const STATE_FILE = join(STATE_DIR, "betman-state.json");

function loadState(): { lastHash: string } {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    // ignore corrupt state
  }
  return { lastHash: "" };
}

function saveState(hash: string): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify({ lastHash: hash }));
}

async function main() {
  const message = await fetchBetmanSchedule();

  if (!message) {
    console.error("No active games found.");
    process.exit(2);
  }

  // Check for duplicate
  const hash = createHash("md5").update(message).digest("hex");
  const state = loadState();
  if (state.lastHash === hash) {
    console.error("No changes since last send, skipping.");
    process.exit(2);
  }

  // Output message and save state
  console.log(message);
  saveState(hash);
}

main().catch((err) => {
  console.error("betman-schedule error:", err.message ?? err);
  process.exit(1);
});
