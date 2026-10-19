/**
 * Shape validation for Cinépolis payloads. Only the fields we rely on are
 * required; anything else may change freely. A mismatch raises
 * CINES_SCHEMA_CHANGED instead of letting a guess reach the user.
 */
import { z } from "zod";
import { CinesError } from "../errors.js";

const str = z.string();
const optStr = z.string().nullish();

export const ShowtimeSchema = z.object({
  format: z.object({ name: str }).nullish(),
  sessionId: str,
  datetime: str,
  screen: z.union([str, z.number()]).nullish(),
  experience: z.object({ name: str }).nullish(),
  movieVistaId: optStr,
  cinemaVistaId: str,
  alerts: z.array(z.object({ section: optStr, title: optStr, message: optStr })).nullish(),
  availability: optStr,
  isAllocatedSeating: z.boolean().nullish(),
});

export const BillboardSchema = z.object({
  dates: z.array(str),
  schedules: z.array(
    z.object({
      cinemaId: str,
      cityId: optStr,
      movieId: str,
      dates: z.array(
        z.object({
          date: str,
          languages: z.array(z.object({ language: str, displayLanguage: optStr, showtimes: z.array(ShowtimeSchema) })),
        }),
      ),
    }),
  ),
});

export const CinemaNodeSchema = z.object({
  id: str,
  lat: z.union([str, z.number()]).nullish(),
  lng: z.union([str, z.number()]).nullish(),
  name: str,
  type: optStr,
  cityId: optStr,
  vistaId: z.union([str, z.number()]),
  timezone: optStr,
  businessType: optStr,
  settings: z.object({ requireContiguousSeating: z.boolean().nullish() }).nullish(),
});

export const CinemasSchema = z.object({ cinemasById: z.object({ edges: z.array(z.object({ node: CinemaNodeSchema })) }) });

export const MovieNodeSchema = z.object({
  id: str,
  name: str,
  originalName: optStr,
  rating: optStr,
  ratingDescription: optStr,
  genre: z.array(str).nullish(),
  synopsis: optStr,
  length: optStr,
  availableForSale: z.boolean().nullish(),
  alerts: z.array(z.object({ title: optStr, message: optStr })).nullish(),
  releaseDate: optStr,
  categories: z.array(str).nullish(),
  experiences: z.array(z.object({ name: str })).nullish(),
  tags: z.array(z.object({ name: str })).nullish(),
  media: z.array(z.object({ resource: optStr, type: optStr })).nullish(),
});

export const MoviesSchema = z.object({
  movies: z.object({
    pageInfo: z.object({ endCursor: optStr, hasNextPage: z.boolean().nullish() }).nullish(),
    edges: z.array(z.object({ node: MovieNodeSchema })),
  }),
});

export const MovieSchema = z.object({ movie: MovieNodeSchema.nullable() });

export const SeatSchema = z.object({
  id: str,
  status: str,
  originalStatus: optStr,
  seatStyle: optStr,
  position: z.object({ columnIndex: z.number(), rowIndex: z.number(), areaNumber: z.number() }),
});

export const SeatsSchema = z.object({
  seats: z.object({
    maxQuantity: z.number().nullish(),
    seatLayoutData: z.object({
      areas: z.array(
        z.object({
          rowCount: z.number(),
          columnCount: z.number(),
          description: optStr,
          areaCategoryCode: str,
          rows: z.array(z.object({ physicalName: optStr, seats: z.array(SeatSchema) })),
        }),
      ),
      areaCategories: z
        .array(z.object({ areaCategoryCode: str, name: optStr, description: optStr, seatType: optStr, capacity: optStr }))
        .nullish(),
    }),
  }),
});

export const TicketsSchema = z.object({
  tickets: z.array(
    z.object({
      areaCategoryCode: str,
      tickets: z.array(
        z.object({
          id: str,
          ticketTypeCode: str,
          description: str,
          priceInCents: z.number(),
          bookingFee: z.number().nullish(),
          taxInCents: z.number().nullish(),
          quantityAvailablePerOrder: z.number().nullish(),
          type: optStr,
          isPackageTicket: z.boolean().nullish(),
        }),
      ),
    }),
  ),
});

export function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue ? issue.path.join(".") : "?";
    throw new CinesError("CINES_SCHEMA_CHANGED", `Cinépolis ${what} response changed shape (${path}: ${issue?.message ?? "invalid"})`);
  }
  return r.data;
}
