import { describe, expect, it } from "vitest";
import { teamRunState, type TeamFlow } from "../src/index.ts";

const flow = (o: Partial<TeamFlow>) => ({ status: "done", waitingFor: null, lanes: {}, ...o }) as Pick<TeamFlow, "status" | "waitingFor" | "lanes">;

describe("teamRunState", () => {
  it("shows a failed step as failed, not quiet", () => {
    const r = teamRunState([flow({ status: "waiting", waitingFor: { why: "x", options: "retry", failed: true } })]);
    expect(r.state).toBe("failed");
    expect(r.text).toMatch(/^Failed/);
  });
  it("finds the failure in a lane when the request has several steps running", () => {
    const lanes = { a: { stepId: "a", status: "waiting", waitingFor: { why: "x", options: "retry", failed: true } } } as unknown as TeamFlow["lanes"];
    expect(teamRunState([flow({ status: "waiting", lanes })]).state).toBe("failed");
  });
  it("shows the failure even while the request itself still says running (steps in parallel)", () => {
    const lanes = { a: { stepId: "a", status: "waiting", waitingFor: { why: "x", options: "retry", failed: true } }, b: { stepId: "b", status: "running", waitingFor: null } } as unknown as TeamFlow["lanes"];
    expect(teamRunState([flow({ status: "running", lanes })], "Atlas").state).toBe("failed");
  });
  it("a plain decision is waiting for you, not failed", () => {
    expect(teamRunState([flow({ status: "waiting", waitingFor: { why: "x", options: "rounds" } })]).state).toBe("needs-you");
  });
  it("a stopped request is not quiet or done", () => {
    expect(teamRunState([flow({ status: "failed" })]).state).toBe("stopped");
  });
  it("working, then quiet only when nothing is happening and the last request is done", () => {
    expect(teamRunState([flow({ status: "running" })], "Bea").text).toBe("Working · Bea is on it");
    expect(teamRunState([flow({ status: "done" })]).state).toBe("quiet");
    expect(teamRunState([]).text).toBe("Quiet");
  });
});
