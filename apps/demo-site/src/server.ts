import express from "express";
import { renderDemoPage, type DemoVariant } from "./renderDemoPage.js";
import { renderNcbaFixture } from "./renderNcbaFixture.js";

export function createDemoServer(
  port = Number(process.env.DEMO_PORT ?? 4173),
  host = process.env.DEMO_HOST ?? "0.0.0.0",
) {
  const app = express();

  app.disable("x-powered-by");
  app.get("/health", (_req, res) =>
    res.json({ ok: true, status: "healthy", service: "demo-site" }),
  );
  app.get("/", (req, res) => {
    const variant = req.query.variant === "B" ? "B" : "A";
    res.redirect(`/demo?variant=${variant}`);
  });
  app.get("/demo", (req, res) => {
    const variant: DemoVariant = req.query.variant === "B" ? "B" : "A";
    res.type("html").send(renderDemoPage(variant));
  });
  app.get("/ncba-fixture", (req, res) => {
    const mode = req.query.mode === "clinical" ? "clinical" : "training";
    const variant = req.query.variant === "B" ? "B" : "A";
    res.type("html").send(renderNcbaFixture(mode, variant));
  });

  const server = app.listen(port, host, () => {
    console.log(`Demo site listening on http://${host}:${port}/demo?variant=A`);
  });

  return { app, server };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createDemoServer();
}
