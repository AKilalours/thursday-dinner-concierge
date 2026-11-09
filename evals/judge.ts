// LLM judge for the message a booker reads before approving. Deterministic graders cover safety;
// this covers what code cannot: is the proposal clear, complete and honest enough to approve from a phone?
// Calibrate it against human labels (evals/calibrate.ts) before trusting its number.
import { z } from "zod";
import { structured } from "../src/llm/client.ts";
import type { LLM } from "../src/llm/client.ts";

export const RUBRIC = `Score 1-5 how well this message lets a busy executive assistant approve or reject a booking from their phone.
5: venue, room, date, time, headcount, total cost and deposit are all stated; any risk or assumption (an ambiguous date, a suspicious email, extra approvers) is called out plainly; nothing is overstated.
3: the essentials are there but something that matters is missing or buried.
1: missing the essentials, misleading, or claims something was done that was not.`;

const Verdict = z.object({ score: z.number().int().min(1).max(5), reason: z.string().max(400) });

export async function judgeMessage(llm: LLM, request: string, message: string) {
  const r = await structured(llm, "judge_proposal_message", Verdict, `You grade a concierge agent's messages. ${RUBRIC} Reply with JSON {"score","reason"}.`,
    `Booker's request: ${request}\n\nAgent's message:\n<<<\n${message}\n>>>`);
  return r.value;
}
