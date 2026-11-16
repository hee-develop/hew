/** 원문 단위(§3.2)의 형식. */
import type { Platform } from "../figma/inventory.js";

export const UNIT_KINDS = ["table_row", "bullet", "paragraph", "figma_screen", "figma_desc"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export type Actor = "operator" | "provider" | "customer";

export interface DocLocator {
  section: string[];
  table?: number;
  row?: number;
  index?: number;
}

export interface FigmaLocator {
  node_id: string;
  name: string;
}

export interface Unit {
  id: string;
  source_id: string;
  kind: UnitKind;
  locator: DocLocator | FigmaLocator;
  text: string;
  columns?: Record<string, string>;
  actor?: Actor;
  actor_raw?: string;
  platform?: Platform;
  image?: string;
}

/** id 와 원천이 붙기 전의 문서 단위. */
export interface RawDocUnit {
  kind: "table_row" | "bullet" | "paragraph";
  locator: DocLocator;
  text: string;
  columns?: Record<string, string>;
  actor?: Actor;
  actor_raw?: string;
}

export interface UnitsFile {
  units: Unit[];
}
