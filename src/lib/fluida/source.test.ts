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
  it("uses the x-fluida-app-uuid header and the real stamping fields", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "stamp-1",
                badge_id: "0441dad2a61c90",
                user_email: "mario@baboo.eu",
                server_clock_at: "2026-06-15T06:00:00Z",
                direction: "IN",
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
      apiKey: "secret-uuid",
      companyId: "co-123",
    });
    const out = await src.fetch("2026-06-15T00:00:00Z", "2026-06-16T00:00:00Z");

    expect(out.punches).toEqual([
      {
        badge: "0441dad2a61c90",
        email: "mario@baboo.eu",
        timestamp: "2026-06-15T06:00:00Z",
        direction: "in",
        sourceId: "stamp-1",
      },
    ]);
    const firstCall = fetchMock.mock.calls[0];
    const url = String(firstCall[0]);
    expect(url).toContain("/api/v1/stampings/list/co-123");
    expect(url).toContain("from_date=2026-06-15");
    const headers = (firstCall[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["x-fluida-app-uuid"]).toBe("secret-uuid");
    expect(headers.Authorization).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("throws when the punches (stampings) call is not OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 500 })),
    );
    const src = new FluidaApiSource({
      baseUrl: "https://api.fluida.io",
      apiKey: "bad",
      companyId: "co-123",
    });
    await expect(
      src.fetch("2026-06-15T00:00:00Z", "2026-06-16T00:00:00Z"),
    ).rejects.toThrow(/500/);
    vi.unstubAllGlobals();
  });

  it("still returns punches when the leaves call is unauthorized (401)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const src = new FluidaApiSource({
      baseUrl: "https://api.fluida.io",
      apiKey: "scoped-for-stampings-only",
      companyId: "co-123",
    });
    const out = await src.fetch("2026-06-15T00:00:00Z", "2026-06-16T00:00:00Z");
    expect(out.punches).toEqual([]);
    expect(out.leaves).toEqual([]);
    vi.unstubAllGlobals();
  });
});
