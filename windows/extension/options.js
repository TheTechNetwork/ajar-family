import { enroll, getConfig, clearConfig } from "./backend-client.js";

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
  const code = $("code").value.trim();
  const name = $("name").value.trim();
  showStatus("Enrolling…", true);
  try {
    const device = await enroll(backendUrl, code, name);
    showStatus(`Enrolled as ${device.displayName}. Reload YouTube to see policy apply.`, true);
    await render();
  } catch (err) {
    showStatus(String(err.message ?? err), false);
  }
});

$("unenroll").addEventListener("click", async () => {
  await clearConfig();
  await chrome.storage.local.remove(["snapshot", "clockAnchor"]);
  await render();
  showStatus("Unenrolled. Reload the extension.", true);
});

render();
