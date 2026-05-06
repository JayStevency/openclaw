import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

const BASE = "https://www.betman.co.kr";
const SCHEDULE_PAGE = `${BASE}/main/mainPage/gamebuy/gameScheduleListIFR.do`;
const SCHEDULE_API = `${BASE}/buyPsblGame/schedule.do`;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const ACTIVE_STATUSES = new Set(["SaleProgress", "SaleBefore"]);

const SPORT_GROUPS: Record<string, { emoji: string; label: string; order: number }> = {
  프로토: { emoji: "⚽🏀", label: "프로토", order: 1 },
  축구: { emoji: "⚽", label: "축구토토", order: 2 },
  농구: { emoji: "🏀", label: "농구토토", order: 3 },
  배구: { emoji: "🏐", label: "배구토토", order: 4 },
  골프: { emoji: "⛳", label: "골프토토", order: 5 },
};

interface GameEntry {
  gmId: string;
  gameName: string;
  gmOsidTs: number;
  saleStatus: string;
  statusMessage: string;
  saleStartDate: number | null;
  saleEndDate: number | null;
  gameMaster: {
    sportsItem: { sportsItemName: string };
  };
}

interface ScheduleResponse {
  yearMonth: string;
  schedules: {
    data: GameEntry[];
  };
}

async function getSession(): Promise<string> {
  const res = await fetch(SCHEDULE_PAGE, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const c of cookies) {
    const m = c.match(/JSESSIONID=([^;]+)/);
    if (m) {
      return m[1];
    }
  }
  throw new Error("Failed to obtain JSESSIONID");
}

async function fetchSchedule(sessionId: string, yearMonth: string): Promise<ScheduleResponse> {
  const res = await fetch(SCHEDULE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "User-Agent": UA,
      Referer: SCHEDULE_PAGE,
      "X-Requested-With": "XMLHttpRequest",
      Cookie: `JSESSIONID=${sessionId}`,
    },
    body: JSON.stringify({
      gmId: "",
      league: "",
      team: "",
      yearMonth,
      draw: 1,
      start: 0,
      perPage: 100,
      _sbmInfo: { debugMode: "false" },
    }),
  });
  if (!res.ok) {
    throw new Error(`schedule.do returned ${res.status}`);
  }
  return (await res.json()) as ScheduleResponse;
}

function fmtDate(epoch: number | null): string {
  if (!epoch) {
    return "미정";
  }
  const d = new Date(epoch);
  const fmt = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Seoul",
  });
  return fmt
    .format(d)
    .replace(/\bAM\b/, "오전")
    .replace(/\bPM\b/, "오후");
}

function statusEmoji(status: string): string {
  if (status === "SaleProgress") {
    return "🟢 발매중";
  }
  if (status === "SaleBefore") {
    return "⏳ 발매예정";
  }
  return status;
}

function formatMessage(data: ScheduleResponse): string {
  const games = data.schedules.data.filter((g) => ACTIVE_STATUSES.has(g.saleStatus));
  if (games.length === 0) {
    return "";
  }

  // Deduplicate by gmId + gmOsidTs
  const seen = new Set<string>();
  const unique: GameEntry[] = [];
  for (const g of games) {
    const key = `${g.gmId}-${g.gmOsidTs}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(g);
    }
  }

  // Group by sport
  const groups = new Map<string, GameEntry[]>();
  for (const g of unique) {
    const sport = g.gameMaster.sportsItem.sportsItemName;
    if (!groups.has(sport)) {
      groups.set(sport, []);
    }
    groups.get(sport)!.push(g);
  }

  const sortedSports = [...groups.keys()].toSorted((a, b) => {
    const oa = SPORT_GROUPS[a]?.order ?? 99;
    const ob = SPORT_GROUPS[b]?.order ?? 99;
    return oa - ob;
  });

  const ym = data.yearMonth;
  const lines: string[] = [`**베트맨 게임일정 (${ym})**`, ""];

  for (const sport of sortedSports) {
    const info = SPORT_GROUPS[sport] ?? { emoji: "🎯", label: sport, order: 99 };
    lines.push(`**${info.emoji} ${info.label}**`);
    const entries = groups.get(sport)!.toSorted((a, b) => {
      if (a.saleStatus !== b.saleStatus) {
        return a.saleStatus === "SaleProgress" ? -1 : 1;
      }
      return (a.saleEndDate ?? 0) - (b.saleEndDate ?? 0);
    });
    for (const g of entries) {
      let line = `> ${g.gameName} (${g.gmOsidTs}회) | ${statusEmoji(g.saleStatus)}`;
      if (g.saleEndDate && g.saleStatus === "SaleProgress") {
        line += ` | 마감: ${fmtDate(g.saleEndDate)}`;
      }
      lines.push(line);
    }
    lines.push("");
  }

  const now = new Date();
  const ts = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Seoul",
  })
    .format(now)
    .replace(/\bAM\b/, "오전")
    .replace(/\bPM\b/, "오후");
  lines.push(`_${ts} 기준_`);

  return lines.join("\n").trim();
}

/** Fetch betman game schedule and return formatted message */
export async function fetchBetmanSchedule(): Promise<string> {
  const now = new Date();
  const krDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  }).format(now);
  const yearMonth = krDate.replace("-", "");

  const sessionId = await getSession();
  const data = await fetchSchedule(sessionId, yearMonth);
  return formatMessage(data);
}

export const handleSimCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/sim") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(`Ignoring /sim from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
    return { shouldContinue: false };
  }

  try {
    const message = await fetchBetmanSchedule();
    if (!message) {
      return {
        shouldContinue: false,
        reply: { text: "현재 발매중이거나 발매예정인 게임이 없습니다." },
      };
    }
    return { shouldContinue: false, reply: { text: message } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logVerbose(`/sim error: ${msg}`);
    return {
      shouldContinue: false,
      reply: { text: `베트맨 일정 조회 실패: ${msg}` },
    };
  }
};
