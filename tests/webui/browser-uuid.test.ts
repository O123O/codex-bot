import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserUuid } from "../../webui-client/src/browser-uuid.ts";

test("creates a UUID when randomUUID is unavailable on a plain HTTP origin", () => {
  let fill = 0;
  const value = createBrowserUuid({
    getRandomValues: ((bytes: Uint8Array) => {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = fill++;
      return bytes;
    }) as Crypto["getRandomValues"],
  });

  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});
