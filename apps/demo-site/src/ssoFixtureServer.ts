import express from "express";

export function createSsoFixtureServer(
  port = Number(process.env.SSO_FIXTURE_PORT ?? 4275),
  host = process.env.SSO_FIXTURE_HOST ?? "0.0.0.0",
) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) =>
    res.json({ ok: true, status: "healthy", service: "synthetic-sso" }),
  );
  app.get("/login", (req, res) => {
    const returnTo =
      typeof req.query.return_to === "string"
        ? req.query.return_to
        : "about:blank";
    const serializedReturnTo = JSON.stringify(returnTo).replaceAll(
      "<",
      "\\u003c",
    );
    res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Synthetic SSO</title></head>
<body><main>
  <h1>SYNTHETIC SSO AUTHENTICATION</h1>
  <p>No credentials, patient data, or external identity provider is used.</p>
  <button id="continue" type="button">Continue synthetic authentication</button>
  <button id="popup" type="button">Open synthetic authentication popup</button>
</main><script>
document.getElementById("continue").addEventListener("click", () => {
  window.location.href = ${serializedReturnTo};
});
document.getElementById("popup").addEventListener("click", () => {
  window.open("/popup?return_to=" + encodeURIComponent(${serializedReturnTo}) + "&popup_token=SYNTHETIC-POPUP-TOKEN", "synthetic-sso-popup");
});
</script></body></html>`);
  });
  app.get("/popup", (req, res) => {
    const returnTo =
      typeof req.query.return_to === "string"
        ? req.query.return_to
        : "about:blank";
    const serializedReturnTo = JSON.stringify(returnTo).replaceAll(
      "<",
      "\\u003c",
    );
    res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Synthetic SSO Popup</title></head>
<body><main>
  <h1>SYNTHETIC SSO POPUP</h1>
  <button id="complete" type="button">Complete synthetic popup authentication</button>
</main><script>
document.getElementById("complete").addEventListener("click", () => {
  if (window.opener) window.opener.location.href = ${serializedReturnTo};
  window.close();
});
</script></body></html>`);
  });
  app.get("/frame", (_req, res) => {
    res
      .type("html")
      .send(
        "<!doctype html><title>Synthetic support frame</title><p>Structural support frame.</p>",
      );
  });
  app.get("/outside", (_req, res) => {
    res
      .type("html")
      .send("<!doctype html><title>Outside origin</title><p>Outside.</p>");
  });
  const server = app.listen(port, host, () => {
    console.log(`Synthetic SSO fixture listening on http://${host}:${port}`);
  });
  return { app, server };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createSsoFixtureServer();
}
