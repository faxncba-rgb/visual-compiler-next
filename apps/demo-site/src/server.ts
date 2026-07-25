import express from "express";
import { renderDemoPage, type DemoVariant } from "./renderDemoPage.js";
import { renderNcbaFixture } from "./renderNcbaFixture.js";

export function createDemoServer(
  port = Number(process.env.DEMO_PORT ?? 4173),
  host = process.env.DEMO_HOST ?? "0.0.0.0",
) {
  const app = express();
  const syntheticAuthOrigin =
    process.env.SSO_AUTH_ORIGIN ?? "http://127.0.0.1:4275";

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
  app.get("/sso-app/start", (_req, res) => {
    const returnTo = `http://127.0.0.1:${port}/sso-app/callback?session_token=SYNTHETIC-RETURN-TOKEN`;
    res.redirect(
      `${syntheticAuthOrigin}/login?return_to=${encodeURIComponent(returnTo)}&bootstrap_token=SYNTHETIC-BOOTSTRAP-TOKEN`,
    );
  });
  app.get("/sso-app/callback", (_req, res) => {
    const crossOriginFrame = `${syntheticAuthOrigin}/frame?frame_token=SYNTHETIC-FRAME-TOKEN`;
    res
      .type("html")
      .send(
        renderNcbaFixture("training", "A").replace(
          "</main>",
          `<p role="status">SYNTHETIC SSO AUTHENTICATION COMPLETE</p><iframe title="Synthetic cross-origin support frame" src="${crossOriginFrame}"></iframe></main>`,
        ),
      );
  });
  app.get("/sso-app/leave", (_req, res) => {
    res.redirect(
      `${syntheticAuthOrigin}/outside?exit_token=SYNTHETIC-EXIT-TOKEN`,
    );
  });

  const server = app.listen(port, host, () => {
    console.log(`Demo site listening on http://${host}:${port}/demo?variant=A`);
  });

  return { app, server };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createDemoServer();
}
