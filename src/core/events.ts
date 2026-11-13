/** events.jsonl 덧붙이기와 읽기. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface HewEvent {
  ts: string;
  type: string;
  data: unknown;
}

export function appendEvent(eventsPath: string, type: string, data: unknown, now: Date = new Date()): HewEvent {
  const event: HewEvent = { ts: now.toISOString(), type, data };
  mkdirSync(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export function readEvents(eventsPath: string): HewEvent[] {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as HewEvent);
}
