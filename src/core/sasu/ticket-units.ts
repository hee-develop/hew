/** 분해안 정본에서 티켓 사수 작업 단위(T1)와 inputs 를 만든다. 티켓 하나가 단위 하나다. */
import { existsSync } from "node:fs";
import { AnalysisItemsSchema } from "../analysis/schema.js";
import { HewError, stateError } from "../errors.js";
import { readJsonFile } from "../fsx.js";
import { runPaths } from "../paths.js";
import { PlanItemsSchema, type Ticket } from "../plan/schema.js";
import { make, type WorkUnit } from "./units.js";

function readItems(file: string): unknown {
  return (readJsonFile(file) as { items?: unknown }).items;
}

/** 티켓이 맡은 변경 항목의 index. changes 가 없으면 그 요구의 변경 전부. */
function takenIndexes(ticket: Ticket, requirementId: string, total: number): number[] {
  const mine = ticket.changes.filter((c) => c.requirement_id === requirementId).map((c) => c.index);
  return mine.length > 0 ? [...new Set(mine)].sort((a, b) => a - b) : Array.from({ length: total }, (_, i) => i);
}

/** 분해안 정본과 분석 정본에서 티켓마다 작업 단위 T1 하나를 만든다. */
export function buildTicketUnits(runDir: string): WorkUnit[] {
  const p = runPaths(runDir);
  if (!existsSync(p.plan)) throw stateError("분해안 정본(doc/plan.json)이 없어 티켓 사수 작업 단위를 만들 수 없습니다");
  if (!existsSync(p.analysis)) throw stateError("분석 정본(doc/analysis.json)이 없어 티켓 사수 작업 단위를 만들 수 없습니다");
  const plan = PlanItemsSchema.safeParse(readItems(p.plan));
  if (!plan.success) throw new HewError("internal", `plan.json 형식이 올바르지 않습니다: ${plan.error.issues[0]?.message ?? ""}`);
  const analysis = AnalysisItemsSchema.safeParse(readItems(p.analysis));
  if (!analysis.success) throw new HewError("internal", `analysis.json 형식이 올바르지 않습니다: ${analysis.error.issues[0]?.message ?? ""}`);
  const reqById = new Map(analysis.data.requirements.map((r) => [r.id, r]));
  return plan.data.tickets.map((t) =>
    make("T1", t.id, {
      epic_name: plan.data.epic_name,
      title: t.title,
      body: t.body,
      requirements: t.requirement_ids.flatMap((id) => {
        const req = reqById.get(id);
        if (req === undefined) return [];
        const changes = takenIndexes(t, id, req.changes.length).flatMap((i) => (req.changes[i] === undefined ? [] : [req.changes[i]?.text ?? ""]));
        return [{ id: req.id, title: req.title, changes }];
      }),
    }),
  );
}
