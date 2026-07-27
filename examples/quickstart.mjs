// Runnable quickstart. Drives the live API with an API key.
//   BARAKO_URL=https://.../barakocms-api BARAKO_KEY=bcms_... node examples/quickstart.mjs
import { createClient, BarakoError } from "../dist/index.js";

const cms = createClient({ baseUrl: process.env.BARAKO_URL, apiKey: process.env.BARAKO_KEY });

// Read
const types = await cms.contentTypes.list();
console.log("content types:", types.map((t) => t.name).slice(0, 8));

const page = await cms.contents.list({ pageSize: 3 });
console.log("entries total:", page.totalItems, "returned:", page.items.length);

// Write (needs a write scope)
const typeName = "sdk_demo_" + Date.now().toString(36);
await cms.contentTypes.create({
  name: typeName,
  displayName: "SDK Demo",
  fields: [{ name: "Title", displayName: "Title", type: "string", isRequired: true }],
});
const created = await cms.contents.create({ contentType: typeName, data: { Title: "Hello from the SDK" }, status: 1 });
console.log("created entry:", created.id, "v" + created.version);

// Typed error handling
try {
  await cms.contents.create({ contentType: typeName, data: {} }); // missing required Title
} catch (e) {
  if (e instanceof BarakoError) console.log("validation rejected as expected:", e.status);
}
console.log("OK");
