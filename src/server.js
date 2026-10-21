import "dotenv/config";
import app from "./app.js";
import { testDatabaseConnection } from "./config/db.js";

const port = process.env.PORT || 4000;

async function start() {
  await testDatabaseConnection();
  app.listen(port, () => {
    console.log(`Kabad Factory API running on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start API", error);
  process.exit(1);
});
