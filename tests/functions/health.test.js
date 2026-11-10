import { describe, expect, it } from "vitest";

const project = "demo-njpbs";
const region = "us-central1";
const host = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const healthUrl = `http://${host}/${project}/${region}/health`;

describe("health function smoke test", () => {
  it("responds 200 with an ok status", async () => {
    const res = await fetch(healthUrl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
