import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import Home from "./page";

describe("Home page", () => {
  it("renders the product headline", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { name: /resolve support tickets/i }),
    ).toBeInTheDocument();
  });

  it("links to sign-up and sign-in", () => {
    render(<Home />);
    expect(screen.getByRole("link", { name: /get started/i })).toHaveAttribute(
      "href",
      "/sign-up",
    );
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute(
      "href",
      "/sign-in",
    );
  });
});
