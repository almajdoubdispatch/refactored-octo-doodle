var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// _lib/founder-waitlist.js
var MAX_BODY_BYTES = 8192;
var QUALIFYING_CARRIER_THRESHOLD = 5;
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    }
  });
}
__name(jsonResponse, "jsonResponse");
function configuration(env) {
  let supabaseUrl;
  try {
    const parsed = new URL(env.SUPABASE_URL || "");
    if (parsed.protocol !== "https:") return null;
    supabaseUrl = parsed.origin;
  } catch {
    return null;
  }
  if (env.FOUNDER_WAITLIST_ENABLED !== "true" || !env.SUPABASE_SERVICE_ROLE_KEY || !env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY || !env.FOUNDER_PRIVACY_NOTICE_VERSION) return null;
  return {
    supabaseUrl,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    turnstileSecret: env.TURNSTILE_SECRET_KEY,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    privacyVersion: env.FOUNDER_PRIVACY_NOTICE_VERSION
  };
}
__name(configuration, "configuration");
function supabaseHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    "content-type": "application/json"
  };
}
__name(supabaseHeaders, "supabaseHeaders");
async function readWaitlistState(env, fetcher = fetch) {
  const config = configuration(env);
  if (!config) return { ready: false };
  try {
    const response = await fetcher(
      `${config.supabaseUrl}/rest/v1/rpc/founder_waitlist_status`,
      {
        method: "POST",
        headers: supabaseHeaders(config.serviceKey),
        body: "{}"
      }
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
      privacyVersion: config.privacyVersion
    };
  } catch {
    return { ready: false };
  }
}
__name(readWaitlistState, "readWaitlistState");
function validateRegistration(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const allowed = /* @__PURE__ */ new Set([
    "carrierName",
    "authorityType",
    "authorityNumber",
    "email",
    "equipment",
    "truckCount",
    "phone",
    "privacyAcknowledged",
    "turnstileToken"
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;
  const carrierName = typeof input.carrierName === "string" ? input.carrierName.trim().replace(/\s+/g, " ") : "";
  const authorityType = typeof input.authorityType === "string" ? input.authorityType.trim().toUpperCase() : "";
  const authorityNumber = typeof input.authorityNumber === "string" ? input.authorityNumber.replace(/\D/g, "") : "";
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
  if (!Number.isSafeInteger(truckCount) || truckCount < 1 || truckCount > 2147483647) return null;
  if (phoneDigits.length < 10 || phoneDigits.length > 15 || !/^\+?[0-9 ()-]+$/.test(phone)) return null;
  if (input.privacyAcknowledged !== true) return null;
  if (turnstileToken.length < 10 || turnstileToken.length > 2048) return null;
  return {
    carrierName,
    authorityType,
    authorityNumber,
    email,
    equipment,
    truckCount,
    phone,
    turnstileToken
  };
}
__name(validateRegistration, "validateRegistration");
async function onStatusGet({ env }, fetcher = fetch) {
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
    privacyNoticeVersion: state.privacyVersion
  });
}
__name(onStatusGet, "onStatusGet");
async function onRegistrationPost({ request, env }, fetcher = fetch) {
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
    response: registration.turnstileToken
  });
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) turnstile.set("remoteip", clientIp);
  try {
    const verifyResponse = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: turnstile
    });
    if (!verifyResponse.ok) return jsonResponse({ error: "verification_unavailable" }, 503);
    const verified = await verifyResponse.json();
    const officialTestSecret = "1x0000000000000000000000000000000AA";
    const isLoopbackPreview = ["localhost", "127.0.0.1", "[::1]"].includes(requestUrl.hostname);
    const officialLocalTest = config.turnstileSecret === officialTestSecret && isLoopbackPreview && verified.hostname === "example.com";
    if (verified.success !== true || verified.hostname !== requestUrl.hostname && !officialLocalTest) {
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
    p_privacy_acknowledged: true
  };
  try {
    const insertResponse = await fetcher(`${config.supabaseUrl}/rest/v1/rpc/register_founder_waitlist`, {
      method: "POST",
      headers: {
        ...supabaseHeaders(config.serviceKey)
      },
      body: JSON.stringify(rpcInput)
    });
    if (!insertResponse.ok) {
      let databaseError = {};
      try {
        databaseError = await insertResponse.json();
      } catch {
      }
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
      founderEligibility: identityVerified ? "eligible" : "pending_identity_review"
    }, 201);
  } catch {
    return jsonResponse({ error: "registration_unavailable" }, 503);
  }
}
__name(onRegistrationPost, "onRegistrationPost");

// api/founder-waitlist/registrations.js
function onRequestPost(context) {
  return onRegistrationPost(context);
}
__name(onRequestPost, "onRequestPost");

// api/founder-waitlist/status.js
function onRequestGet(context) {
  return onStatusGet(context);
}
__name(onRequestGet, "onRequestGet");

// ../.wrangler/tmp/pages-8jMpLX/functionsRoutes-0.043349772580207.mjs
var routes = [
  {
    routePath: "/api/founder-waitlist/registrations",
    mountPath: "/api/founder-waitlist",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost]
  },
  {
    routePath: "/api/founder-waitlist/status",
    mountPath: "/api/founder-waitlist",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  }
];

// ../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function getOriginalPathPrefix(requestPath, normalizedPrefix) {
  let end = 0;
  for (let index = 0; index < normalizedPrefix.length; index++) {
    end++;
    if (normalizedPrefix[index] === "/") {
      while (requestPath[end] === "/") {
        end++;
      }
    }
  }
  return requestPath.slice(0, end);
}
__name(getOriginalPathPrefix, "getOriginalPathPrefix");
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  const normalizedRequestPath = requestPath.replace(/\/+/g, "/");
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath) || routeMatcher(normalizedRequestPath);
    const originalMountMatch = mountMatcher(requestPath);
    const mountMatchResult = originalMountMatch || mountMatcher(normalizedRequestPath);
    if (matchResult && mountMatchResult) {
      const path = originalMountMatch ? originalMountMatch.path : getOriginalPathPrefix(requestPath, mountMatchResult.path);
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
