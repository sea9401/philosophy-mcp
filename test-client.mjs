import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, OPENALEX_MAILTO: process.env.OPENALEX_MAILTO || "test@example.com" },
});
const client = new Client({ name: "test", version: "0.0.0" });
await client.connect(transport);

const sep = (t) => console.log("\n" + "=".repeat(8) + " " + t + " " + "=".repeat(8));

sep("tools/list");
const { tools } = await client.listTools();
console.log(tools.map((t) => `- ${t.name}: ${t.title}`).join("\n"));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  console.log(`isError=${!!r.isError}`);
  console.log(r.content.map((c) => c.text).join("\n"));
};

sep("search_papers (phenomenal consciousness, oa-only, 3)");
await call("search_papers", { query: "phenomenal consciousness higher-order", limit: 3, open_access_only: true });

sep("get_paper (BROTNO-9)");
await call("get_paper", { id: "https://philarchive.org/rec/BROTNO-9" });

sep("list_recent (last 3 days, 3)");
const from = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
await call("list_recent", { from, limit: 3 });

sep("fetch_pdf (BROTNO-9)");
await call("fetch_pdf", { id: "BROTNO-9" });

sep("get_paper (bad id)");
await call("get_paper", { id: "THIS-DOES-NOT-EXIST-9999" });

await client.close();
console.log("\nDONE");
