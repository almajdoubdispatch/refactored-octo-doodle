const MAX_BODY_BYTES = 8_192;
const QUALIFYING_CARRIER_THRESHOLD = 5;

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function configuration(env) {
  let supabaseUrl;
  try {
    const parsed = new URL(env.SUPABASE_URL || "");
    if (parsed.protocol !== "https:") return null;
    supabaseUrl = parsed.origin;
  } catch {
    return null;
  }

  if (
    env.FOUNDER_WAITLIST_ENABLED !== "true" ||
    !env.SUPABASE_SERVICE_ROLE_KEY ||
    !env.TURNSTILE_SECRET_KEY ||
    !env.TURNSTILE_SITE_KEY ||
    !env.FOUNDER_PRIVACY_NOTICE_VERSION
  ) return null;

  return {
    supabaseUrl,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    turnstileSecret: env.TURNSTILE_SECRET_KEY,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    privacyVersion: env.FOUNDER_PRIVACY_NOTICE_VERSION,
  };
}

function supabaseHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    "content-type": "application/json",
  };
}

export async function readWaitlistState(env, fetcher = fetch) {
  const config = configuration(env);
  if (!config) return { ready: false };

  try {
    const response = await fetcher(
      `${config.supabaseUrl}/rest/v1/rpc/founder_waitlist_status`,
      {
        method: "POST",
        headers: supabaseHeaders(config.serviceKey),
        body: "{}",
      },
    );
    if (!response.ok) return { ready: false };
    const gate = await response.json();
    if (!gate || typeof gate !== "object" || typeof gate.open !== "boolean") return { ready: false };
    const qualifyingCount = Number(gate.qualifyingCount);
    if (!Number.isSafeInteger(qualifyingCount) || qualifyingCount < 0 || qualifyingCount > QUALIFYING_CARRIER_THRESHOLD) {
      return { ready: false };
    }
    return {
      ready: true,
      open: gate.open && qualifyingCount < QUALIFYING_CARRIER_THRESHOLD,
      turnstileSiteKey: config.turnstileSiteKey,
      privacyVersion: config.privacyVersion,
    };
  } catch {
    return { ready: false };
  }
}

export function validateRegistration(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const allowed = new Set([
    "carrierName", "authorityType", "authorityNumber", "email",
    "equipment", "truckCount", "phone", "privacyAcknowledged", "turnstileToken",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;

  const carrierName = typeof input.carrierName === "string"
    ? input.carrierName.trim().replace(/\s+/g, " ")
    : "";
  const authorityType = typeof input.authorityType === "string" ? input.authorityType.trim().toUpperCase() : "";
  const authorityNumber = typeof input.authorityNumber === "string"
    ? input.authorityNumber.replace(/\D/g, "")
    : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const equipment = typeof input.equipment === "string" ? input.equipment.trim() : "";
  const truckCount = Number(input.truckCount);
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  const phoneDigits = phone.replace(/\D/g, "");
  const turnstileToken = typeof input.turnstileToken === "string" ? input.turnstileToken.trim() : "";

  if (carrierName.length < 2 || carrierName.length > 160) return null;
  if (!["MC", "USDOT"].includes(authorityType)) return null;
  if (!/^\d{1,12}$/.test(authorityNumber)) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  if (!["dry_van", "reefer"].includes(equipment)) return null;
  if (!Number.isSafeInteger(truckCount) || truckCount < 1 || truckCount > 2_147_483_647) return null;
  if (phoneDigits.length < 10 || phoneDigits.length > 15 || !/^\+?[0-9 ()-]+$/.test(phone)) return null;
  if (input.privacyAcknowledged !== true) return null;
  if (turnstileToken.length < 10 || turnstileToken.length > 2_048) return null;

  return {
    carrierName,
    authorityType,
    authorityNumber,
    email,
    equipment,
    truckCount,
    phone,
    turnstileToken,
  };
}

export async function onStatusGet({ env }, fetcher = fetch) {
  const state = await readWaitlistState(env, fetcher);
  if (!state.ready) {
    return jsonResponse({ available: false, message: "Registration is temporarily unavailable." }, 503);
  }
  if (!state.open) {
    return jsonResponse({ available: false, closed: true, message: "The Founder Waitlist is closed." });
  }
  return jsonResponse({
    available: true,
    turnstileSiteKey: state.turnstileSiteKey,
    privacyNoticeVersion: state.privacyVersion,
  });
}

export async function onRegistrationPost({ request, env }, fetcher = fetch) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!origin || origin !== requestUrl.origin) {
    return jsonResponse({ error: "same_origin_required" }, 403);
  }
  if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    return jsonResponse({ error: "json_required" }, 415);
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return jsonResponse({ error: "request_too_large" }, 413);
  let raw;
  let input;
  try {
    raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return jsonResponse({ error: "request_too_large" }, 413);
    input = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const registration = validateRegistration(input);
  if (!registration) return jsonResponse({ error: "invalid_registration" }, 400);

  const config = configuration(env);
  if (!config) return jsonResponse({ error: "registration_unavailable" }, 503);

  const turnstile = new URLSearchParams({
    secret: config.turnstileSecret,
    response: registration.turnstileToken,
  });
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) turnstile.set("remoteip", clientIp);

  try {
    const verifyResponse = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: turnstile,
    });
    if (!verifyResponse.ok) return jsonResponse({ error: "verification_unavailable" }, 503);
    const verified = await verifyResponse.json();
    const officialTestSecret = "1x0000000000000000000000000000000AA";
    const isLoopbackPreview = ["localhost", "127.0.0.1", "[::1]"].includes(requestUrl.hostname);
    const officialLocalTest = config.turnstileSecret === officialTestSecret &&
      isLoopbackPreview && verified.hostname === "example.com";
    if (verified.success !== true || (verified.hostname !== requestUrl.hostname && !officialLocalTest)) {
      return jsonResponse({ error: "verification_failed" }, 422);
    }
  } catch {
    return jsonResponse({ error: "verification_unavailable" }, 503);
  }

  const referenceCode = `ADW-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const rpcInput = {
    p_reference_code: referenceCode,
    p_carrier_name: registration.carrierName,
    p_authority_type: registration.authorityType,
    p_authority_number: registration.authorityNumber,
    p_email: registration.email,
    p_equipment: registration.equipment,
    p_truck_count: registration.truckCount,
    p_phone: registration.phone,
    p_privacy_notice_version: config.privacyVersion,
    p_privacy_acknowledged: true,
  };

  try {
    const insertResponse = await fetcher(`${config.supabaseUrl}/rest/v1/rpc/register_founder_waitlist`, {
      method: "POST",
      headers: {
        ...supabaseHeaders(config.serviceKey),
      },
      body: JSON.stringify(rpcInput),
    });
    if (!insertResponse.ok) {
      let databaseError = {};
      try { databaseError = await insertResponse.json(); } catch {}
      const code = databaseError.code || "";
      const message = databaseError.message || databaseError.error || "";
      if (message === "waitlist_closed") return jsonResponse({ error: "waitlist_closed" }, 409);
      if (["duplicate_authority", "duplicate_identity"].includes(message)) {
        return jsonResponse({ error: "duplicate_authority" }, 409);
      }
      if (message === "invalid_registration") return jsonResponse({ error: "invalid_registration" }, 400);
      if (code === "23505" && String(databaseError.details || "").includes("founder_waitlist_authority_unique")) {
        return jsonResponse({ error: "duplicate_authority" }, 409);
      }
      return jsonResponse({ error: "registration_unavailable" }, 503);
    }
    let result = await insertResponse.json();
    if (Array.isArray(result)) [result] = result;
    if (!result || result.outcome !== "registered" || !result.reference_code) {
      return jsonResponse({ error: "registration_unavailable" }, 503);
    }
    const identityVerified = result.identity_status === "VERIFIED" && Boolean(result.founder_eligible_at);
    return jsonResponse({
      ok: true,
      referenceCode: result.reference_code,
      identityStatus: result.identity_status,
      founderEligibility: identityVerified ? "eligible" : "pending_identity_review",
    }, 201);
  } catch {
    return jsonResponse({ error: "registration_unavailable" }, 503);
  }
}
