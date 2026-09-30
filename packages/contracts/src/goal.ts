import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString, NonNegativeInt } from "./baseSchemas.ts";

export const ProviderGoal = Schema.Struct({
  threadId: Schema.String,
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  status: Schema.Literals([
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ]),
  tokenBudget: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  tokensUsed: NonNegativeInt,
  timeUsedSeconds: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ProviderGoal = typeof ProviderGoal.Type;

export const NativeGoalState = Schema.Struct({
  available: Schema.Boolean,
  goal: Schema.NullOr(ProviderGoal),
});
export type NativeGoalState = typeof NativeGoalState.Type;

export const ProviderGoalInput = Schema.Struct({
  threadId: ThreadId,
  action: Schema.Literals(["get", "set", "clear"]),
  objective: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4000))),
  status: Schema.optionalKey(Schema.Literals(["active", "paused"])),
  tokenBudget: Schema.optionalKey(Schema.NullOr(NonNegativeInt.check(Schema.isGreaterThan(0)))),
});
export type ProviderGoalInput = typeof ProviderGoalInput.Type;

export class ProviderGoalError extends Schema.TaggedError<ProviderGoalError>()(
  "ProviderGoalError",
  {
    threadId: ThreadId,
    detail: Schema.String,
  },
) {}
