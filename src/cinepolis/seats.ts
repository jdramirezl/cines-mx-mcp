/** Map the Cinépolis `Seats` payload to the shared SeatLayout. */
import type { z } from "zod";
import type { Seat, SeatLayout, SeatRow, SeatState } from "../seats.js";
import type { SeatsSchema } from "./schemas.js";

/** Status enum from the site's seats micro-frontend. */
const STATUS: Record<string, SeatState | "placeholder"> = {
  Empty: "available",
  Sold: "taken",
  House: "taken",
  Reserved: "taken",
  Broken: "blocked",
  Special: "wheelchair",
  Companion: "companion",
  Placeholder: "placeholder",
};

/**
 * Geometry (verified against the site's rendering of Parque Toreo Sala 6):
 * rowIndex 0 is the back row, so rows are flipped to put the screen first;
 * columnIndex runs right-to-left from the audience's view, so x is mirrored.
 * Multiple areas are stacked in API order.
 */
export function mapSeatLayout(data: z.infer<typeof SeatsSchema>, requireContiguous = false): SeatLayout {
  const sl = data.seats.seatLayoutData;
  const unknown = new Set<string>();
  const counts: Record<SeatState, number> = { available: 0, taken: 0, wheelchair: 0, companion: 0, blocked: 0 };
  const rows: SeatRow[] = [];
  let maxCol = 0;
  for (const a of sl.areas) for (const r of a.rows) for (const s of r.seats) maxCol = Math.max(maxCol, s.position.columnIndex, a.columnCount - 1);
  for (const area of sl.areas) {
    const areaRows = [...area.rows].filter((r) => r.seats.length).sort((a, b) => b.seats[0]!.position.rowIndex - a.seats[0]!.position.rowIndex);
    for (const r of areaRows) {
      const name = (r.physicalName ?? "").trim().toUpperCase() || "?";
      const seats: Seat[] = [];
      for (const s of r.seats) {
        const mapped = STATUS[s.status];
        if (mapped === "placeholder") continue;
        const state: SeatState = mapped ?? "taken";
        if (!mapped) unknown.add(s.status);
        counts[state]++;
        seats.push({
          label: `${name}${s.id}`,
          row: name,
          number: s.id,
          x: maxCol - s.position.columnIndex,
          y: rows.length,
          state,
          areaCode: area.areaCategoryCode,
          ref: { areaNumber: s.position.areaNumber, rowIndex: s.position.rowIndex, columnIndex: s.position.columnIndex },
        });
      }
      rows.push({ name, y: rows.length, seats: seats.sort((p, q) => p.x - q.x) });
    }
  }
  const xs = rows.flatMap((r) => r.seats.map((s) => s.x));
  const first = sl.areas[0];
  const cat = sl.areaCategories?.find((c) => c.areaCategoryCode === first?.areaCategoryCode);
  return {
    areaName: (cat?.name ?? first?.description ?? "").trim(),
    areaCode: first?.areaCategoryCode ?? "",
    rows,
    minX: xs.length ? Math.min(...xs) : 0,
    maxX: xs.length ? Math.max(...xs) : 0,
    maxQuantity: data.seats.maxQuantity ?? 10,
    requireContiguous,
    unknownStatuses: [...unknown],
    counts,
  };
}
