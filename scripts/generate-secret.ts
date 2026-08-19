import crypto from "node:crypto";

console.log(`SEARXNG_SECRET=${crypto.randomBytes(32).toString("hex")}`);
