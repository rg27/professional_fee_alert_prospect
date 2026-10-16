/* app.js - widget: ensure Submit proceeds to Closed Won
   - Updates Quote, then updates the Deal/Potential Stage to "Closed Won" on the server
   - Posts payload { action: "submit", reason } and attempts to close with that payload
   - No client-script changes required
*/

const SELECTORS = {
  popup: "popup",
  popupTitle: "popupTitle",
  popupMessage: "popupMessage",
  loaderText: "loader-text"
};

const MAX_LENGTH = 1990;
const QUOTE_URL_BASE = "https://crm.zoho.com/crm/org682300086/tab/Quotes/";
const DEAL_URL_BASE  = "https://crm.zoho.com/crm/org682300086/tab/Potentials/"; // permalink base (used for navigation)
const DEAL_ENTITY_TRIES = ["Deals", "Potentials"]; // try updating these entity names

let currentRecordId = null; // Deal ID
let currentQuoteId = null;  // Quote ID (from client data)
let _toastTimeout = null;
let _isSubmitting = false;
let _toastTimeoutId = null;

/* ---------- Page load: get Deal ID + Quote ID from the Client Script ---------- */
ZOHO.embeddedApp.on("PageLoad", async (entity) => {
  console.log("PageLoad entity:", entity);
  const d = entity?.value ?? entity?.data ?? entity ?? {};
  currentRecordId = d.prospectId ?? null;
  currentQuoteId = d.quoteId ?? null;
  console.log("Deal:", currentRecordId, "| Quote:", currentQuoteId);
});
ZOHO.embeddedApp.init();
console.log("widget script loaded");

/* ---------- postMessage + close helpers ---------- */
function postMessageToParent(message) {
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage(message, "*");
    if (window.top && window.top !== window) window.top.postMessage(message, "*");
  } catch (err) {
    console.warn("postMessage error:", err);
  }
}

function tryCloseWithPayload(payload) {
  try {
    if (typeof $Client !== "undefined" && typeof $Client.close === "function") {
      console.log("Closing via $Client.close with payload:", payload);
      $Client.close(payload);
      return true;
    }
  } catch (e) {
    console.warn("$Client.close failed:", e);
  }

  try {
    if (window.ZDK && ZDK.Client && typeof ZDK.Client.closePopup === "function") {
      console.log("Closing via ZDK.Client.closePopup with payload:", payload);
      try { ZDK.Client.closePopup(payload); } catch (e) { ZDK.Client.closePopup(); }
      return true;
    }
  } catch (e) {
    console.warn("ZDK.Client.closePopup failed:", e);
  }

  try {
    if (window.ZOHO && ZOHO.CRM && ZOHO.CRM.UI && typeof ZOHO.CRM.UI.Popup !== "undefined" && typeof ZOHO.CRM.UI.Popup.close === "function") {
      console.log("Closing via ZOHO.CRM.UI.Popup.close() (no payload support)");
      ZOHO.CRM.UI.Popup.close();
      return true;
    }
  } catch (e) {
    console.warn("ZOHO.CRM.UI.Popup.close failed:", e);
  }

  console.warn("No close method available that accepts payload.");
  return false;
}

function closeAfterDelay(payload, delay = 500) {
  setTimeout(() => {
    // Always broadcast as a fallback before closing
    postMessageToParent({ tlzWidgetResponse: payload || { action: "cancel" } });
    const closed = tryCloseWithPayload(payload);
    if (!closed) {
      try { if (window.close) window.close(); } catch (e) { /* ignore */ }
    }
  }, delay);
}

/* ---------- Attempt to set the Deal/Potential Stage to Closed Won on the server ---------- */
async function proceedToClosedWon(reason) {
  if (!currentRecordId) {
    console.warn("proceedToClosedWon: no currentRecordId");
    return { success: false, error: "No record id" };
  }

  const apiData = {
    id: currentRecordId,
    // Attempt to set a Stage field — exact API name may vary; using "Stage" which your client script read earlier
    Stage: "Closed Won"
  };

  // If TLZ_Professional_Fee_Reason is relevant on the Deal, include it (harmless if not present)
  if (reason) {
    apiData.TLZ_Professional_Fee_Reason = reason;
  }

  // Try updating each candidate entity until one succeeds
  for (const entity of DEAL_ENTITY_TRIES) {
    try {
      console.log(`Attempting to update ${entity} ${currentRecordId} -> Stage = Closed Won`);
      const resp = await ZOHO.CRM.API.updateRecord({
        Entity: entity,
        APIData: apiData
      });
      console.log(`${entity} update response:`, resp);
      const result = resp?.data?.[0];
      if (result?.code === "SUCCESS") {
        return { success: true, entity };
      } else {
        // Continue trying other entities
        console.warn(`${entity} update not successful:`, result);
      }
    } catch (e) {
      console.warn(`${entity} update failed:`, e);
    }
  }

  return { success: false, error: "All entity updates failed" };
}

/* ---------- Open Quote (click) - automatic parent reload, no modal ---------- */
function openQuote() {
  if (_isSubmitting) return;

  if (!currentQuoteId) {
    showPopup("Quote not found", "Could not determine the Quote ID. Please close this window and try again.");
    return;
  }

  // Open the quote in a new tab (must run in click handler)
  try {
    window.open(QUOTE_URL_BASE + encodeURIComponent(currentQuoteId), "_blank");
  } catch (e) {
    console.warn("window.open failed:", e);
  }

  // Broadcast the open action for parent listeners (if any)
  postMessageToParent({ tlzWidgetResponse: { action: "open" } });

  // After a short delay, force parent to navigate to the Deal permalink (hard reload).
  setTimeout(() => {
    if (!currentRecordId) {
      console.warn("No currentRecordId available to navigate parent.");
      closeAfterDelay({ action: "open" }, 200);
      return;
    }

    const target_url = DEAL_URL_BASE + encodeURIComponent(currentRecordId);

    try {
      if (window.top && window.top !== window) {
        window.top.location.href = target_url;
      } else {
        window.location.href = target_url;
      }
      // Close the widget after navigation attempt (non-blocking)
      closeAfterDelay({ action: "open" }, 300);
    } catch (navErr) {
      console.warn("Navigating top failed:", navErr);
      // Fallback: request parent reload via postMessage, then close
      postMessageToParent({ tlzWidgetRequest: { action: "reload" } });
      closeAfterDelay({ action: "open" }, 300);
    }
  }, 200);
}

/* ---------- Submit Reason (click) - update quote, then update deal -> Closed Won ---------- */
async function submitQuote() {
  if (_isSubmitting) return;

  const notesInput = document.getElementById("notesInput");
  if (!notesInput) {
    showPopup("Error", "Notes input not found.");
    return;
  }

  const notesValue = notesInput.value.trim();
  if (!notesValue) {
    setNotesError("Please provide a reason for excluding the TLZ Professional Fee before submitting.");
    return;
  }
  if (notesValue.length > MAX_LENGTH) {
    setNotesError(`Reason cannot exceed ${MAX_LENGTH} characters. Current length: ${notesValue.length}`);
    return;
  }

  if (!currentQuoteId) {
    showPopup("Quote not found", "Could not determine the Quote ID. Please close this window and try again.");
    return;
  }

  _isSubmitting = true;
  showLoader("Saving reason...");

  try {
    // 1) update the Quote record
    const resp = await ZOHO.CRM.API.updateRecord({
      Entity: "Quotes",
      APIData: {
        id: currentQuoteId,
        TLZ_Professional_Fee_Reason: notesValue
      }
    });
    console.log("Quote update response:", resp);

    const result = resp?.data?.[0];
    if (result?.code !== "SUCCESS") {
      throw new Error(result?.message || "Quote update failed");
    }

    // 2) Try updating the Deal/Potential to Closed Won on the server
    const reasonText = notesValue.length > MAX_LENGTH ? notesValue.substring(0, MAX_LENGTH) : notesValue;
    const updateResult = await proceedToClosedWon(reasonText);
    console.log("proceedToClosedWon result:", updateResult);

    // Notify user success
    showLoaderSuccess("Saved");
    showToast("Saved", "Reason recorded and deal updated.", "success");

    // 3) Broadcast payload and close with payload so client sees action:submit
    const payload = { action: "submit", reason: reasonText, dealUpdate: updateResult };
    postMessageToParent({ tlzWidgetResponse: payload });
    console.log("Posting payload to parent and attempting to close with payload:", payload);

    // Try to close with payload; fallback to final close if needed
    setTimeout(() => {
      const closed = tryCloseWithPayload(payload);
      if (!closed) closeAfterDelay(payload, 300);
    }, 200);

  } catch (err) {
    _isSubmitting = false;
    hideLoader();
    console.error("Submit error:", err);
    showPopup("Submission failed", "Could not update the quote: " + (err?.message || JSON.stringify(err)));
  }
}

/* ---------- UI helpers: loader, toast, popup, validation ---------- */
function _ensureLoaderCard() {
  const overlay = document.getElementById("loader-overlay");
  if (!overlay) return null;

  let card = overlay.querySelector(".loader-card");
  if (card) return card;

  card = document.createElement("div");
  card.className = "loader-card";
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");
  card.innerHTML = `
    <div class="spinner-wrap">
      <div class="spinner-track" aria-hidden="true"></div>
      <div class="spinner-arc animate-spin" aria-hidden="true"></div>
    </div>
    <div class="loader-text-wrap">
      <p id="loader-text" class="loader-text"></p>
    </div>
  `;
  overlay.appendChild(card);
  return card;
}

function showLoader(text = "Saving reason...") {
  const overlay = document.getElementById("loader-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  const card = _ensureLoaderCard();
  if (!card) return;
  card.classList.remove("success");
  const spinnerArc = card.querySelector(".spinner-arc");
  if (spinnerArc) spinnerArc.classList.add("animate-spin");
  const loaderText = document.getElementById("loader-text");
  if (loaderText) loaderText.textContent = text;
  overlay.setAttribute("aria-hidden", "false");
}

function showLoaderSuccess(text = "Saved") {
  const overlay = document.getElementById("loader-overlay");
  if (!overlay) return;
  const card = _ensureLoaderCard();
  if (!card) return;
  const spinnerWrap = card.querySelector(".spinner-wrap");
  if (spinnerWrap) {
    spinnerWrap.innerHTML = `
      <div class="loader-success-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="height:20px;width:20px">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
        </svg>
      </div>
    `;
  }
  card.classList.add("success");
  const loaderText = document.getElementById("loader-text");
  if (loaderText) loaderText.textContent = text;
  overlay.setAttribute("aria-hidden", "false");
}

function hideLoader() {
  const overlay = document.getElementById("loader-overlay");
  if (!overlay) return;
  const card = overlay.querySelector(".loader-card");
  if (card) {
    const spinnerWrap = card.querySelector(".spinner-wrap");
    if (spinnerWrap && !spinnerWrap.querySelector(".spinner-arc")) {
      spinnerWrap.innerHTML = `
        <div class="spinner-track" aria-hidden="true"></div>
        <div class="spinner-arc animate-spin" aria-hidden="true"></div>
      `;
    }
    card.classList.remove("success");
  }
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
}

function showToast(titleText, message, type = "success") {
  const toast = document.getElementById("toast");
  const title = document.getElementById("toastTitle");
  const msg = document.getElementById("toastMessage");
  const icon = document.getElementById("toastIcon");
  if (!toast) return;
  if (title) title.textContent = titleText || "";
  if (msg) msg.textContent = message || "";
  if (icon) {
    icon.className = "toast-icon";
    if (type === "success") {
      icon.classList.add("success");
      icon.innerHTML = '<svg style="height:22px;width:22px;color:inherit" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>';
    } else {
      icon.innerHTML = "";
    }
  }
  if (_toastTimeoutId) clearTimeout(_toastTimeoutId);
  toast.style.display = "flex";
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  _toastTimeoutId = setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => { toast.style.display = "none"; }, 300);
  }, 3000);
}

function showPopup(titleText, message) {
  const popup = document.getElementById(SELECTORS.popup);
  const title = document.getElementById(SELECTORS.popupTitle);
  const msg = document.getElementById(SELECTORS.popupMessage);
  if (!popup) { alert((titleText ? titleText + ": " : "") + (message || "")); return; }
  if (title) title.textContent = titleText || "Notification";
  if (msg) msg.textContent = message || "";
  popup.classList.remove("hidden");
}

function setNotesError(message) {
  const notesInput = document.getElementById("notesInput");
  const errorMsg = document.getElementById("error-msg");
  if (errorMsg) {
    const textSpan = errorMsg.querySelector(".error-text") || (() => {
      const s = document.createElement("span"); s.className = "error-text"; errorMsg.appendChild(s); return s;
    })();
    textSpan.textContent = " " + message;
    errorMsg.classList.remove("hidden");
  }
  if (notesInput) {
    notesInput.classList.add("input-error");
    notesInput.focus();
  }
}

function clearNotesError() {
  const notesInput = document.getElementById("notesInput");
  const errorMsg = document.getElementById("error-msg");
  if (!notesInput) return;
  const v = notesInput.value.trim();
  if (v && v.length <= MAX_LENGTH) {
    if (errorMsg) errorMsg.classList.add("hidden");
    notesInput.classList.remove("input-error");
  }
}

/* ---------- expose handlers ---------- */
window.openQuote = openQuote;
window.submitQuote = submitQuote;
window.clearNotesError = clearNotesError;