export type FixtureMode = "training" | "clinical";
export type FixtureVariant = "A" | "B";

const recordsA = [
  ["TEST-ADMIN-001", "Document received", "Open"],
  ["TEST-ADMIN-002", "Identity check queued", "Open"],
] as const;
const recordsB = [...recordsA].reverse();

export function renderNcbaFixture(mode: FixtureMode, variant: FixtureVariant) {
  const records = variant === "A" ? recordsA : recordsB;
  const warning =
    mode === "training"
      ? "SYNTHETIC DATA ONLY — GPT-5.6 COMPILATION ENABLED."
      : "CLINICAL RUNTIME — OPENAI ACCESS FORBIDDEN.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ncba-dpi-fixture</title><style>
body{font:16px system-ui;margin:0;background:#f4f7fa;color:#17212b}.banner{padding:14px;background:${mode === "training" ? "#fff0b8" : "#ffd5d5"};font-weight:800}.wrap{max-width:900px;margin:28px auto;padding:18px;background:white;border:1px solid #ccd5df;border-radius:10px}label{display:grid;gap:6px;margin:12px 0}input,button{font:inherit;padding:10px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:12px;border:1px solid #d8e0e8;text-align:left}.synthetic{color:#176a43;font-weight:800}.controls{display:flex;gap:8px;align-items:center}
</style></head><body><div class="banner" role="status">${warning}</div><main class="wrap">
<h1>ncba-dpi-fixture</h1><p class="synthetic">SYNTHETIC TRAINING ENVIRONMENT — NO PATIENT DATA</p>
<section aria-label="Fictitious login"><h2>Fictitious login</h2><label>Demo account<input aria-label="Demo account" data-vc-stable-label="demo-account" value="" autocomplete="off"></label><button type="button" data-vc-stable-label="manual-sign-in-simulation">Manual sign-in simulation</button></section>
<table aria-label="Synthetic administrative queue"><caption>Synthetic administrative queue — layout ${variant}</caption><thead><tr><th>Test record</th><th>Administrative status</th><th>Reversible action</th></tr></thead><tbody>
${records.map(([id, status, action]) => `<tr><td>${id}</td><td>${status}</td><td><div class="controls"><label><input type="checkbox" data-vc-stable-label="administrative-row-selection" aria-label="${id} selected"> Select</label><button type="button" data-vc-stable-label="reversible-administrative-action" aria-label="${action} ${id}">${action}</button></div></td></tr>`).join("")}
</tbody></table><p id="result" role="status">No administrative action executed.</p></main>
<script>
  document.querySelectorAll("tbody button").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("result").textContent = "Synthetic administrative action staged";
    });
  });
</script></body></html>`;
}
