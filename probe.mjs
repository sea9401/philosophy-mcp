import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env },
});
const client = new Client({ name: "probe", version: "0.0.0" });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log("OK tools:", tools.length);
  await client.close();
  console.log("DONE");
} catch (e) {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
}
