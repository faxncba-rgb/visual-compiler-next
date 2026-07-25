export function renderCgiFixture() {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Fixture CGI professionnelle synthétique</title>
  <style>
    body{margin:0;background:#eef2f5;color:#17212b;font:16px system-ui}
    .banner{padding:14px;background:#fff0b8;font-weight:900}
    main{max-width:920px;margin:24px auto;padding:20px}
    section{margin:18px 0;padding:18px;border:1px solid #bcc8d3;border-radius:8px;background:white}
    label{display:block;margin:10px 0 6px;font-weight:700}
    textarea{box-sizing:border-box;width:100%;min-height:120px;padding:10px;font:inherit}
    button{margin-top:12px;padding:10px 18px;font:inherit}
    [role=status]{font-weight:700;color:#176a43}
  </style>
</head>
<body>
  <div class="banner" role="status">SYNTHETIC TRAINING ENVIRONMENT — NO PATIENT DATA</div>
  <main>
    <h1>Application CGI administrative synthétique</h1>
    <p>Fixture locale sans code, contenu ou marque provenant d’un DPI réel.</p>

    <section aria-labelledby="observation-heading">
      <h2 id="observation-heading">Compte rendu administratif</h2>
      <label for="observation">Observation du praticien</label>
      <textarea id="observation" name="observation" placeholder="Saisir une observation administrative">VALEUR-SYNTHETIQUE-A-SUPPRIMER</textarea>
      <button type="button" class="save">Enregistrer</button>
      <p id="observation-result" role="status">Aucune modification enregistrée.</p>
    </section>

    <section aria-labelledby="correspondence-heading">
      <h2 id="correspondence-heading">Correspondance interne</h2>
      <label for="internal-note">Notes internes</label>
      <textarea id="internal-note" name="internal-note" placeholder="Saisir une note interne">AUTRE-VALEUR-SYNTHETIQUE-SECRETE</textarea>
      <button type="button" class="save">Enregistrer</button>
      <p id="internal-result" role="status">Aucune note enregistrée.</p>
    </section>

    <input type="hidden" name="session_token" value="TOKEN-SYNTHETIQUE-EXCLU">
  </main>
  <script>
    const sections = Array.from(document.querySelectorAll("section"));
    sections[0].querySelector("button").addEventListener("click", () => {
      document.getElementById("observation-result").textContent =
        "Enregistrement synthétique effectué";
    });
    sections[1].querySelector("button").addEventListener("click", () => {
      document.getElementById("internal-result").textContent =
        "Note synthétique enregistrée";
    });
  </script>
</body>
</html>`;
}
