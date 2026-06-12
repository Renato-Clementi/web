import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import Home from "./page";

describe("Home page", () => {
  it("renders the running placeholder heading", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { name: /the app is running/i }),
    ).toBeInTheDocument();
  });
});
