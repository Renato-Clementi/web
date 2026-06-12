import { describe, expect, it } from "vitest";
import { normalizeOdooUrl } from "./odoo";

describe("normalizeOdooUrl", () => {
  it("strips a trailing /odoo web-client segment so JSON-RPC hits the host root", () => {
    // Regression: ODOO_URL provisioned as the web backend path produced
    // `https://host/odoo/jsonrpc`, which 400s with an invalid-CSRF error.
    expect(normalizeOdooUrl("https://host.dev.odoo.com/odoo")).toBe(
      "https://host.dev.odoo.com",
    );
  });

  it("strips a trailing slash", () => {
    expect(normalizeOdooUrl("https://host.dev.odoo.com/")).toBe(
      "https://host.dev.odoo.com",
    );
  });

  it("strips a trailing /odoo with a trailing slash", () => {
    expect(normalizeOdooUrl("https://host.dev.odoo.com/odoo/")).toBe(
      "https://host.dev.odoo.com",
    );
  });

  it("strips a legacy /web segment", () => {
    expect(normalizeOdooUrl("https://host.example.com/web")).toBe(
      "https://host.example.com",
    );
  });

  it("leaves a bare host root untouched", () => {
    expect(normalizeOdooUrl("https://host.dev.odoo.com")).toBe(
      "https://host.dev.odoo.com",
    );
  });

  it("does not strip an unrelated path that merely contains odoo", () => {
    expect(normalizeOdooUrl("https://host.example.com/odoofoo")).toBe(
      "https://host.example.com/odoofoo",
    );
  });
});
