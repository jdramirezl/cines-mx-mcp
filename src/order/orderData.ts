/**
 * Build the `Order` mutation input exactly like cinepolis.com does
 * (captured 2026-10-19, Parque Toreo, 2 × Admision General).
 */
import { randomUUID } from "node:crypto";
import type { Cinema, Showtime } from "../domain.js";
import type { TicketType } from "../provider.js";
import type { Seat, SeatLayout } from "../seats.js";

export interface RawTicket {
  id: string;
  ticketTypeCode: string;
  description: string;
  priceInCents: number;
  bookingFee?: number | null;
  taxInCents?: number | null;
  type?: string | null;
  isPackageTicket?: boolean | null;
  quantityAvailablePerOrder?: number | null;
}

/** The site's orderSessionId: `${uuidv4}-${Date.now()}` (50 chars), kept for the whole checkout. */
export function newOrderSessionId(now = Date.now()): string {
  return `${randomUUID()}-${now}`;
}

export interface OrderInputArgs {
  orderSessionId: string;
  /** `user_session_id` from UserSessionId — used as tickets.orderId. */
  userSessionId: string;
  countryId: string;
  cinema: Cinema;
  showtime: Showtime;
  movie: { name: string; image?: string };
  layout: SeatLayout;
  seats: Seat[];
  tickets: RawTicket[];
  selectedTicketId: string;
}

export function buildOrderData(a: OrderInputArgs) {
  const area = a.layout.areaName || a.cinema.type;
  const options = (selected: boolean) => (t: RawTicket) => {
    const base = {
      id: t.id,
      type: t.type ?? "general",
      description: t.description,
      ticketTypeCode: t.ticketTypeCode,
      price: t.priceInCents,
      selected,
      isPackageTicket: t.isPackageTicket ?? false,
    };
    // The site zeroes fees on the selected option and adds loyalty markers.
    return selected
      ? { ...base, loyaltyRecognitionId: "", isThirdMember: false, taxInCents: 0, bookingFee: 0, taxRate: { cgstRate: 0, sgstRate: 0 } }
      : { ...base, taxInCents: t.taxInCents ?? 0, bookingFee: t.bookingFee ?? 0, taxRate: { cgstRate: 0, sgstRate: 0 } };
  };
  return {
    orderSessionId: a.orderSessionId,
    billingInfo: { gstin: "", hsn: 0, sac: "", fssai: "" },
    countryId: a.countryId,
    cinema: {
      id: a.cinema.id,
      name: a.cinema.name,
      type: a.cinema.type,
      vistaId: a.cinema.vistaId,
      businessType: a.cinema.businessType ?? a.cinema.type,
    },
    tickets: {
      orderId: a.userSessionId,
      providerName: "vista",
      movie: { name: a.movie.name, image: a.movie.image ?? "", type: "" },
      schedule: { sessionId: a.showtime.sessionId, screenNumber: a.showtime.screen, language: a.showtime.language },
      seats: a.seats.map((s) => ({
        number: s.label,
        capacity: 1,
        description: area.toUpperCase(),
        areaCategoryCode: s.areaCode,
        position: { columnIndex: s.ref.columnIndex, areaNumber: s.ref.areaNumber, rowIndex: s.ref.rowIndex },
        ticketsOptions: [
          ...a.tickets.filter((t) => t.id !== a.selectedTicketId).map(options(false)),
          ...a.tickets.filter((t) => t.id === a.selectedTicketId).map(options(true)),
        ],
      })),
    },
  };
}

/** Pick the ticket type: explicit request first, else the profile default. Account/Club tickets never by default. */
export function chooseTicket(tickets: TicketType[], requested: string | undefined, defaultType: string): TicketType | undefined {
  const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
  if (requested) {
    const q = norm(requested);
    return tickets.find((t) => norm(t.description) === q) ?? tickets.find((t) => norm(t.description).includes(q));
  }
  const d = norm(defaultType);
  return tickets.find((t) => norm(t.description) === d) ?? tickets.find((t) => /general|adulto/i.test(norm(t.description)) && !t.isPackage);
}
