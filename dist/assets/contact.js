const inquiryForm = document.querySelector("#carrier-inquiry-form");
const inquirySubmit = document.querySelector("#inquiry-submit");
const inquiryMessage = document.querySelector("#inquiry-message");

const SUPABASE_REST_URL = "https://rnduoxdzyeqteamqsars.supabase.co/rest/v1/inquiries";
const SUPABASE_ANON_KEY = "sb_publishable_q8ON25cKslO1BpS4D_gvLw_JNbW4i0S";

function showInquiryMessage(text, state = "info") {
  if (!inquiryMessage) return;
  inquiryMessage.textContent = text;
  inquiryMessage.dataset.state = state;
}

if (inquiryForm) {
  inquiryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!inquiryForm.reportValidity()) return;

    if (inquirySubmit) inquirySubmit.disabled = true;
    showInquiryMessage("Submitting your inquiry to our dispatch operations desk…");

    const data = new FormData(inquiryForm);
    const carrierName = (data.get("carrierName") || "").toString().trim();
    const contactName = (data.get("contactName") || "").toString().trim();
    const authorityType = (data.get("authorityType") || "MC").toString().trim();
    const authorityNumber = (data.get("authorityNumber") || "").toString().trim();
    const phone = (data.get("phone") || "").toString().trim();
    const email = (data.get("email") || "").toString().trim();
    const rawEquipment = (data.get("equipment") || "53_dry_van").toString().trim();
    const equipment = rawEquipment === "53_reefer" || rawEquipment === "reefer" ? "53_reefer" : (rawEquipment === "other" ? "other" : "53_dry_van");
    const truckCountRaw = parseInt(data.get("truckCount") || "1", 10);
    const truckCount = Number.isSafeInteger(truckCountRaw) && truckCountRaw > 0 ? truckCountRaw : 1;
    const preferredLanes = (data.get("preferredLanes") || "").toString().trim();
    const notes = (data.get("notes") || "").toString().trim();
    const tcpaConsent = data.get("tcpaConsent") === "on";

    const payload = {
      name: contactName || carrierName,
      company_name: carrierName,
      phone: phone,
      email: email,
      mc_number: authorityType === "MC" ? authorityNumber : null,
      dot_number: authorityType === "USDOT" ? authorityNumber : null,
      equipment_type: equipment,
      truck_count: truckCount,
      preferred_lanes: preferredLanes,
      notes: notes,
      source: "Website Carrier Intake Form",
      status: "NEW_LEAD",
      tcpa_consent: tcpaConsent,
    };

    if (window.location.protocol === "file:") {
      inquiryForm.reset();
      showInquiryMessage("Local preview mode: Inquiry validated. When hosted online, data transmits live to the operations desk.", "success");
      if (inquirySubmit) inquirySubmit.disabled = false;
      return;
    }

    try {
      const response = await fetch(SUPABASE_REST_URL, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok || response.status === 201) {
        inquiryForm.reset();
        showInquiryMessage("Inquiry received! Our dispatch operations desk has recorded your details and will follow up promptly.", "success");
      } else {
        const errorText = await response.text();
        console.warn("[Inquiry Submit] Supabase error:", response.status, errorText);
        showInquiryMessage("Submission could not be completed right now. Please call our desk directly at (409) 941-7180.", "error");
      }
    } catch (err) {
      console.warn("[Inquiry Submit] Network exception:", err);
      showInquiryMessage("Network connection error. Please call our desk directly at (409) 941-7180.", "error");
    } finally {
      if (inquirySubmit) inquirySubmit.disabled = false;
    }
  });
}
