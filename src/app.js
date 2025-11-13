const api = {
  async status() {
    const r = await fetch("/instance/status");
    if (!r.ok) throw new Error("status");
    return r.json();
  },
  async qr() {
    const r = await fetch("/instance/qr");
    if (!r.ok) throw new Error("no_qr");
    return r.json();
  },
  async reset(secret) {
    const r = await fetch("/instance/reset", {
      method: "POST",
      headers: { "x-admin-secret": secret || "" },
    });
    if (!r.ok) throw new Error("reset_failed");
    return r.json();
  },
  async restart() {
    const r = await fetch("/instance/restart", { method: "POST" });
    if (!r.ok) throw new Error("restart_failed");
    return r.json();
  },
};

let polling = null;

async function render() {
  const elStatus = document.getElementById("status");
  const elHasQR = document.getElementById("hasqr");
  const img = document.getElementById("qrimg");
  const copy = document.getElementById("copy");
  try {
    const s = await api.status();
    elStatus.textContent = s.status;
    elHasQR.textContent = s.hasQR ? "sim" : "não";

    if (s.hasQR) {
      try {
        const { qr } = await api.qr();
        copy.value = qr;
      } catch (_) {
        /* mantém valor anterior em caso de corrida */
      }
      try {
        const resp = await fetch("/instance/qr.png?ts=" + Date.now());
        if (resp.ok) {
          copy.value = resp.headers.get("x-qr") || copy.value || "";
        }
      } catch (_) {
        /* ignore */
      }
      img.src = "/instance/qr.png?ts=" + Date.now();
      img.style.display = "block";
    } else {
      img.style.display = "none";
      img.src = "";
      copy.value = "";
    }

    // fallback: tenta buscar QR mesmo em caso de corrida
    try {
      const { qr } = await api.qr();
      copy.value = qr;
      img.src = "/instance/qr.png?ts=" + Date.now();
      img.style.display = "block";
      elHasQR.textContent = "sim";
    } catch (_) {}
  } catch (e) {
    elStatus.textContent = "erro";
  }
}

function startPolling() {
  stopPolling();
  polling = setInterval(render, 2000);
}

function stopPolling() {
  if (polling) clearInterval(polling);
  polling = null;
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-refresh").addEventListener("click", render);
  document.getElementById("btn-start").addEventListener("click", startPolling);
  document.getElementById("btn-stop").addEventListener("click", stopPolling);
  document.getElementById("btn-reset").addEventListener("click", async () => {
    const secret = document.getElementById("secret").value || "";
    if (!confirm("Resetar sessão? Você terá que escanear QR novamente.")) return;
    try {
      await api.reset(secret);
      alert("Reset solicitado. O serviço vai reiniciar.");
    } catch {
      alert("Falha ao resetar. Verifique o segredo.");
    }
  });
  document.getElementById("btn-restart").addEventListener("click", async () => {
    if (!confirm("Reiniciar serviço agora? Sessão será mantida.")) return;
    try {
      await api.restart();
      alert("Reinício solicitado.");
    } catch {
      alert("Falha ao reiniciar.");
    }
  });

  render();
  startPolling();
});
