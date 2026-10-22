import "dotenv/config";
import app from "./app.js";
import { testDatabaseConnection } from "./config/db.js";

const port = process.env.PORT || 4000;

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Kabad Factory API listening on port ${port}`);

  // Check MySQL after the HTTP server starts.
  testDatabaseConnection()
    .then(() => {
      console.log("Database connection successful");
    })
    .catch((error) => {
      console.error("Database connection failed:", error);
    });
});

server.on("error", (error) => {
  console.error("Failed to start API:", error);
  process.exit(1);
});
