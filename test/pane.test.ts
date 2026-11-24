import { afterEach, describe, expect, it, vi } from "vitest";
import { cameFrom, paneBack, reviewHref } from "../src/ui/pane.ts";

/** A page at `search`, with a session storage of its own: no DOM here, and these read only the two. */
function at(search: string, stored = new Map<string, string>()) {
  vi.stubGlobal("window", { location: { search } });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  return stored;
}

afterEach(() => vi.unstubAllGlobals());

describe("attraverso's pane", () => {
  it("marks a review's link from the pane, and only from there", () => {
    at("?in=pane&back=%2F%3Fpane%3D%252Freviews%252F");
    expect(reviewHref("a b")).toBe("?review=a%20b&from=pane");
    at("?back=%2F");
    expect(reviewHref("a b")).toBe("?review=a%20b");
  });

  it("sends a review opened from the pane back to the viewer the pane kept, with the pane open", () => {
    const stored = at("?in=pane&back=%2F%3Fpane%3D%252Freviews%252F%23demo");
    expect(cameFrom()).toBe("/?pane=%2Freviews%2F#demo");
    at("?review=x&from=pane", stored);
    expect(paneBack()).toBe("/?pane=%2Freviews%2F#demo");
  });

  it("leaves a review opened any other way going to the app's own home page", () => {
    const stored = at("?back=%2F%23demo"); // the phone's page, which keeps a back of its own
    cameFrom();
    at("?review=x", stored);
    expect(paneBack()).toBeNull();
    at("?review=x"); // a direct link, in a fresh tab
    expect(paneBack()).toBeNull();
  });

  it("takes only a path on this host as the way back", () => {
    at("?review=x&from=pane", new Map([["reviewer.back", "//elsewhere.example/"]]));
    expect(paneBack()).toBeNull();
  });
});
