const form = document.querySelector("#founder-waitlist-form");
const submitButton = document.querySelector("#waitlist-submit");
const message = document.querySelector("#waitlist-message");
const turnstileContainer = document.querySelector("#turnstile-container");
let turnstileWidgetId = null;
let turnstileToken = "";

function showMessage(text, state = "info") {
  message.textContent = text;
  message.dataset.state = state;
}

function renderTurnstile(siteKey) {
  turnstileWidgetId = window.turnstile.render(turnstileContainer, {
    sitekey: siteKey,
    callback(token) { turnstileToken = token; submitButton.disabled = false; showMessage("Complete the form and submit your registration."); },
    "expired-callback"() { turnstileToken = ""; submitButton.disabled = true; showMessage("Please complete the spam check again.", "error"); },
    "error-callback"() { turnstileToken = ""; submitButton.disabled = true; showMessage("Spam protection could not load. Try again later.", "error"); },
  });
}

function loadTurnstile(siteKey) {
  return new Promise((resolve, reject) => {
    if (window.turnstile) {
      try { renderTurnstile(siteKey); resolve(); } catch (error) { reject(error); }
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      try { renderTurnstile(siteKey); resolve(); } catch (error) { reject(error); }
    };
    script.onerror = () => reject(new Error("turnstile_load_failed"));
    document.head.append(script);
  });
}

async function initialize() {
  try {
    const response = await fetch("/api/founder-waitlist/status", { headers: { accept: "application/json" }, cache: "no-store" });
    const state = await response.json();
    if (!response.ok || state.available !== true) {
      showMessage(state.message || "The Founder Waitlist is not accepting registrations right now.", "error");
      return;
    }
    await loadTurnstile(state.turnstileSiteKey);
    showMessage("Complete the spam check to enable registration.");
  } catch {
    showMessage("Registration is not available right now. No information has been sent.", "error");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  if (!turnstileToken) {
    showMessage("Complete the spam check before submitting.", "error");
    return;
  }

  submitButton.disabled = true;
  showMessage("Submitting your registration…");
  const data = new FormData(form);
  const payload = {
    carrierName: data.get("carrierName"),
    authorityType: data.get("authorityType"),
    authorityNumber: data.get("authorityNumber"),
    email: data.get("email"),
    equipment: data.get("equipment"),
    truckCount: data.get("truckCount"),
    phone: data.get("phone"),
    privacyAcknowledged: data.get("privacyAcknowledged") === "on",
    turnstileToken,
  };

  try {
    const response = await fetch("/api/founder-waitlist/registrations", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
      turnstileToken = "";
      if (turnstileWidgetId !== null && window.turnstile) window.turnstile.reset(turnstileWidgetId);
      showMessage(result.error === "duplicate_authority"
        ? "A new registration was not created for that authority. If you need to correct an existing entry, contact us."
        : "We could not confirm a new registration. No success has been recorded; please try again later.", "error");
      return;
    }
    form.reset();
    turnstileToken = "";
    if (turnstileWidgetId !== null && window.turnstile) window.turnstile.reset(turnstileWidgetId);
    const eligible = result.founderEligibility === "eligible";
    showMessage(eligible
      ? `Registration received. Reference: ${result.referenceCode}. Founder eligibility is recorded; this is not carrier approval or a service start.`
      : `Registration received. Reference: ${result.referenceCode}. Identity review is required before founder eligibility can be confirmed; this is not carrier approval or a service start.`, "success");
  } catch {
    turnstileToken = "";
    if (turnstileWidgetId !== null && window.turnstile) window.turnstile.reset(turnstileWidgetId);
    showMessage("We could not confirm a new registration. No success has been recorded; please try again later.", "error");
  } finally {
    if (!turnstileToken) submitButton.disabled = true;
  }
});

initialize();
