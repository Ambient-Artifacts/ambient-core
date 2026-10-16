// Team invite links: https://<gateway>/join/<code>, shared from the app. The page opens Ambient
// (ambient://join/<code>), which shows the team and asks before joining.
import express, { type Router } from "express";
import { joinPage } from "./oauth/pages.ts";

export function joinRouter(): Router {
  const r = express.Router();
  r.get("/join/:code", (req, res) => {
    const code = String(req.params.code).trim().toUpperCase();
    if (!/^[A-Z0-9-]{4,32}$/.test(code)) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.set("Cache-Control", "no-store");
    res.set("X-Frame-Options", "DENY");
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'");
    res.type("html").send(joinPage(code));
  });
  return r;
}
