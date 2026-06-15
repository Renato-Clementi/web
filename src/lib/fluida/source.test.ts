import { describe, it, expect, vi } from "vitest";
import { FluidaCsvSource, FluidaApiSource } from "./source";

describe("FluidaCsvSource", () => {
  it("parses punches and converts local Rome times to instants", async () => {
    const csv =
      "badge,email,timestamp,direction\n" +
      "0001,mario@baboo.eu,2026-06-15 08:00:00,entrata\n" +
      "0001,mario@baboo.eu,2026-06-15 17:00:00,uscita\n";
    const src = new FluidaCsvSource(csv);
    const out = await src.fetch();
    expect(out.punches).toHaveLength(2);
    expect(out.punches[0].direction).toBe("in");
    // 08:00 Rome (summer) == 06:00 UTC
    expect(out.punches[0].timestamp).toBe("2026-06-15T06:00:00.000Z");
  });

  it("parses an approved leaves CSV when columns are configured", async () => {
    const leaves =
      "badge,email,leaveType,start,end,approved\n" +
      "0001,mario@baboo.eu,Ferie,2026-06-15 00:00:00,2026-06-16 00:00:00,si\n";
    const src = new FluidaCsvSource(
      "badge,email,timestamp,direction\n",
      leaves,
      {
        leaveColumns: {
          badge: "badge",
          email: "email",
          leaveType: "leaveType",
          start: "start",
          end: "end",
          approved: "approved",
        },
      },
    );
    const out = await src.fetch();
    expect(out.leaves).toHaveLength(1);
    expect(out.leaves[0]).toMatchObject({ leaveType: "Ferie", approved: true });
  });
});

describe("FluidaApiSource", () => {
  it("sends a bearer token and normalizes varied field names", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                matricola: "0001",
                datetime: "2026-06-15T08:00:00+02:00",
                verso: "entrata",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const src = new FluidaApiSource({
      baseUrl: "https://api.fluida.io",
      apiKey: "secret",
    });
    const out = await src.fetch("2026-06-15T00:00:00Z", "2026-06-16T00:00:00Z");

    expect(out.punches).toEqual([
      {
        badge: "0001",
        email: undefined,
        timestamp: "2026-06-15T08:00:00+02:00",
        direction: "in",
        sourceId: undefined,
      },
    ]);
    const firstCall = fetchMock.mock.calls[0];
    const headers = (firstCall[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer secret");
    vi.unstubAllGlobals();
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 401 })),
    );
    const src = new FluidaApiSource({
      baseUrl: "https://api.fluida.io",
      apiKey: "bad",
    });
    await expect(src.fetch("a", "b")).rejects.toThrow(/401/);
    vi.unstubAllGlobals();
  });
});
