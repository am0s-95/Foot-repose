import { z } from 'zod';
import {
  BOOKING_ACTIONS,
  BOOKING_STATUSES,
  CUSTOMER_SEGMENTS,
  EMPLOYEE_ROLES,
} from '@foot-repose/domain';

// ---------------------------------------------------------------- auth

export const loginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const branchSummarySchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  area: z.string(),
});
export type BranchSummary = z.infer<typeof branchSummarySchema>;

export const employeeProfileSchema = z.object({
  employee: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    fullName: z.string(),
    role: z.enum(EMPLOYEE_ROLES),
  }),
  /** Branches this employee may operate on (all active branches for super_admin). */
  branches: z.array(branchSummarySchema),
});
export type EmployeeProfile = z.infer<typeof employeeProfileSchema>;

// ---------------------------------------------------------------- bookings

export const bookingsQuerySchema = z.object({
  /** Muscat calendar day; defaults to today (Asia/Muscat) on the server. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .optional(),
  status: z.enum(BOOKING_STATUSES).optional(),
  /** Case-insensitive match against customer name or phone. */
  q: z.string().trim().min(1).max(100).optional(),
});
export type BookingsQuery = z.infer<typeof bookingsQuerySchema>;

export const bookingDtoSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  status: z.enum(BOOKING_STATUSES),
  startsAt: z.string(),
  endsAt: z.string(),
  /** Wall-clock times in Asia/Muscat, e.g. "14:30". */
  startTimeLocal: z.string(),
  endTimeLocal: z.string(),
  priceBaisa: z.number().int().nonnegative(),
  priceFormatted: z.string(),
  currency: z.literal('OMR'),
  notes: z.string().nullable(),
  service: z.object({
    id: z.string().uuid(),
    name: z.string(),
    durationMin: z.number().int().positive(),
    bufferBeforeMin: z.number().int().nonnegative(),
    bufferAfterMin: z.number().int().nonnegative(),
  }),
  customer: z.object({ id: z.string().uuid(), fullName: z.string(), phone: z.string() }),
  assignedEmployee: z.object({ id: z.string().uuid(), fullName: z.string() }).nullable(),
  /** Actions the CURRENT actor may perform, computed server-side. */
  allowedActions: z.array(z.enum(BOOKING_ACTIONS)),
});
export type BookingDto = z.infer<typeof bookingDtoSchema>;

export const bookingsListResponseSchema = z.object({
  branch: branchSummarySchema,
  date: z.string(),
  bookings: z.array(bookingDtoSchema),
});
export type BookingsListResponse = z.infer<typeof bookingsListResponseSchema>;

export const transitionRequestSchema = z.object({
  action: z.enum(BOOKING_ACTIONS),
});
export type TransitionRequest = z.infer<typeof transitionRequestSchema>;

export const transitionResponseSchema = z.object({ booking: bookingDtoSchema });
export type TransitionResponse = z.infer<typeof transitionResponseSchema>;

// ---------------------------------------------------------------- branches

export const branchesResponseSchema = z.object({ branches: z.array(branchSummarySchema) });
export type BranchesResponse = z.infer<typeof branchesResponseSchema>;

export const customerSegmentSchema = z.enum(CUSTOMER_SEGMENTS);

export const publicBranchSchema = branchSummarySchema.extend({
  phone: z.string(),
  /** null = not yet classified (real classifications are business data). */
  customerSegment: customerSegmentSchema.nullable(),
});
export type PublicBranch = z.infer<typeof publicBranchSchema>;

export const publicBranchesResponseSchema = z.object({ branches: z.array(publicBranchSchema) });
export type PublicBranchesResponse = z.infer<typeof publicBranchesResponseSchema>;

// ---------------------------------------------------------------- catalog

export const publicBranchServiceSchema = z.object({
  serviceId: z.string().uuid(),
  name: z.string(),
  durationMin: z.number().int().positive(),
  priceBaisa: z.number().int().nonnegative(),
  priceFormatted: z.string(),
  bufferBeforeMin: z.number().int().nonnegative(),
  bufferAfterMin: z.number().int().nonnegative(),
  isBookableOnline: z.boolean(),
});
export type PublicBranchService = z.infer<typeof publicBranchServiceSchema>;

export const branchCatalogResponseSchema = z.object({
  branch: publicBranchSchema,
  /** Muscat calendar date the catalog is effective for. */
  date: z.string(),
  services: z.array(publicBranchServiceSchema),
});
export type BranchCatalogResponse = z.infer<typeof branchCatalogResponseSchema>;

// ---------------------------------------------------------------- errors

export const API_ERROR_CODES = [
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_transition',
  'conflict',
  'rate_limited',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.object({ code: z.enum(API_ERROR_CODES), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
