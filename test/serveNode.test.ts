/**
 * The node:http adapter (DIST-2): a handler reads a POST's body, and one it passes on reaches the next middleware with
 * the body unread, as a host's own routes behind these need.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Handler } from "../pipeline/host.ts";
import { nodeHandler } from "../pipeline/serveNode.ts";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

const text = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
};

/**
 * A server running `handler`, with a next middleware that answers "next: <the body it read>", reading it a tick later
 * as a host's own route would after its own async work, so a body drained when the request was adapted reads empty.
 */
const serve = async (handler: Handler): Promise<string> => {
  const middleware = nodeHandler(handler);
  const server = createServer((request, response) =>
    middleware(request, response, () =>
      setTimeout(() => void text(request).then((body) => response.end(`next: ${body}`)), 10),
    ),
  );
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe("nodeHandler", () => {
  it("gives a handler the POST body", async () => {
    const url = await serve(async (request) => new Response(`got: ${await request.text()}`));
    expect(await (await fetch(url, { method: "POST", body: "hello" })).text()).toBe("got: hello");
  });

  it("passes a request it doesn't answer on with its body unread", async () => {
    const url = await serve(async () => undefined);
    expect(await (await fetch(`${url}/elsewhere`, { method: "POST", body: "hello" })).text()).toBe("next: hello");
    expect(await (await fetch(`${url}/elsewhere`)).text()).toBe("next: ");
  });

  it("answers 500 with the message when the handler throws", async () => {
    const url = await serve(async () => {
      throw new Error("broken");
    });
    const answer = await fetch(url);
    expect([answer.status, await answer.text()]).toEqual([500, "broken"]);
  });
});
