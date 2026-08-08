const status = document.getElementById("state");

chrome.runtime.sendMessage({ state: true })
  .then((state) => {
    status.className = state?.reachable ? "good" : "bad";
    status.textContent = state?.reachable
      ? "connected to 127.0.0.1:7717"
      : state?.note || "Project AA is not running on 127.0.0.1:7717";
  })
  .catch((error) => {
    status.className = "bad";
    status.textContent = String(error.message || error);
  });
