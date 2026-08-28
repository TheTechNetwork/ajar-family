import { enroll, getConfig, clearConfig } from "./backend-client.js";

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function render() {
  const cfg = await getConfig();
  const enrolled = !!(cfg.backendUrl && cfg.deviceToken);
  $("enrolled").hidden = !enrolled;
  $("form").hidden = enrolled;
  if (enrolled) {
    $("deviceId").textContent = cfg.deviceId ?? "";
    $("childId").textContent = cfg.childId ?? "";
    $("curUrl").textContent = cfg.backendUrl ?? "";
  }
}
function showStatus(msg, ok) {
  const el = $("status");
  el.hidden = false;
  el.textContent = msg;
  el.className = `status ${ok ? "ok" : "err"}`;
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const backendUrl = $("backendUrl").value.replace(/\/+$/, "");
  showStatus("Enrolling…", true);
  try {
    const device = await enroll(backendUrl, $("code").value.trim(), $("name").value.trim());
    showStatus(`Enrolled as ${device.displayName}. Reload YouTube to see policy apply.`, true);
    await render();
  } catch (err) {
    showStatus(String(err.message ?? err), false);
  }
});

$("unenroll").addEventListener("click", async () => {
  await clearConfig();
  await ext.storage.local.remove("devicePolicySnapshot");
  await render();
  showStatus("Unenrolled. Reload the extension.", true);
});

render();
