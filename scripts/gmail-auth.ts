import "dotenv/config";
import crypto from "node:crypto";
import http from "node:http";
import { google } from "googleapis";

const clientId = process.env.GMAIL_CLIENT_ID?.trim();
const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
const redirectUri =
  process.env.GMAIL_REDIRECT_URI?.trim() || "http://localhost:3000/oauth2callback";

if (!clientId || !clientSecret) {
  throw new Error("Isi GMAIL_CLIENT_ID dan GMAIL_CLIENT_SECRET di .env terlebih dahulu.");
}

const redirect = new URL(redirectUri);
if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(redirect.hostname)) {
  throw new Error("Script lokal ini memerlukan GMAIL_REDIRECT_URI http://localhost/... yang aman.");
}

const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const state = crypto.randomBytes(24).toString("hex");
const authorizationUrl = oauth.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/gmail.readonly"],
  state,
});

const port = Number(redirect.port || 80);
const server = http.createServer(async (request, response) => {
  const callbackUrl = new URL(request.url ?? "/", redirect.origin);
  if (callbackUrl.pathname !== redirect.pathname) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    if (callbackUrl.searchParams.get("state") !== state) {
      response.writeHead(400).end("OAuth state tidak valid.");
      return;
    }
    const code = callbackUrl.searchParams.get("code");
    if (!code) {
      response.writeHead(400).end("Authorization code tidak ditemukan.");
      return;
    }
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      response
        .writeHead(400)
        .end("Google tidak mengembalikan refresh token. Cabut akses app lalu coba lagi.");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Gmail berhasil dihubungkan. Kembali ke terminal.");
    console.log("\nTambahkan nilai berikut ke .env (jangan commit file .env):\n");
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
  } catch (error) {
    response.writeHead(500).end("Gagal menukar authorization code.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(port, redirect.hostname, () => {
  console.log("\nBuka URL berikut di browser dan izinkan akses read-only Gmail:\n");
  console.log(authorizationUrl);
  console.log(`\nMenunggu callback di ${redirectUri} ...`);
});

server.on("error", (error) => {
  console.error(`Server OAuth gagal: ${error.message}`);
  process.exitCode = 1;
});
