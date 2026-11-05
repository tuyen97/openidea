import { describe, expect, it } from "vitest";
import type { PreparedRequest } from "@/platform/ipc";
import { curlCommand } from "./curl";

const request = (over: Partial<PreparedRequest> = {}): PreparedRequest => ({
  name: null,
  method: "GET",
  url: "https://example.test/",
  headers: [],
  body: null,
  ...over,
});

describe("curl command", () => {
  it("renders method, URL, headers and body", () => {
    expect(
      curlCommand(
        request({
          method: "POST",
          url: "https://example.test/items?page=1",
          headers: [
            ["Content-Type", "application/json"],
            ["X-Trace", "a b"],
          ],
          body: '{"a":1}',
        }),
      ),
    ).toBe(
      [
        "curl --request POST",
        "  --url 'https://example.test/items?page=1'",
        "  --header 'Content-Type: application/json'",
        "  --header 'X-Trace: a b'",
        `  --data-raw '{"a":1}'`,
      ].join(" \\\n"),
    );
  });

  it("quotes single quotes in POSIX shell syntax", () => {
    expect(curlCommand(request({ headers: [["X-Name", "O'Reilly"]] }))).toContain(`--header 'X-Name: O'\\''Reilly'`);
  });

  it("omits data for a body-less request", () => {
    expect(curlCommand(request())).toBe("curl --request GET \\\n  --url 'https://example.test/'");
  });
});
