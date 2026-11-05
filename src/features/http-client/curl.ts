/** The request as a POSIX shell cURL command, for the cURL tab. */
import type { PreparedRequest } from "@/platform/ipc";

/** Single-quote for a POSIX shell; an embedded quote becomes `'\''`. */
function shell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function curlCommand(request: PreparedRequest): string {
  const lines = [`curl --request ${request.method}`, `  --url ${shell(request.url)}`];
  for (const [name, value] of request.headers) lines.push(`  --header ${shell(`${name}: ${value}`)}`);
  if (request.body != null) lines.push(`  --data-raw ${shell(request.body)}`);
  return lines.join(" \\\n");
}
